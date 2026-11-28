// The routes under /api/: login, logout, the session, and the placeholder.
import type { IncomingMessage } from "node:http";

import { isObject } from "@money/shared";

import { countByAccount } from "./archive.ts";
import { DUMMY_HASH, verifyPassword } from "./auth/password.ts";
import {
  clearedCookie,
  cookieValue,
  csrfMatches,
  csrfToken,
  decodeSession,
  encodeSession,
  sessionCookie,
  signingKey,
} from "./auth/session.ts";
import type { HandlerDeps } from "./handler.ts";
import { readJson } from "./http/body.ts";
import { crossSiteProblem } from "./http/origin.ts";
import { findByUsername, visibleAccounts } from "./people.ts";
import type { Person } from "./people.ts";
import {
  BODY_REFUSED,
  CROSS_SITE,
  json,
  LOGIN_REFUSED,
  noContent,
  NOT_FOUND,
  REFUSED,
  tooManyAttempts,
  UNAVAILABLE,
} from "./reply.ts";
import type { Reply } from "./reply.ts";
import type { ServerConfig } from "./server-config.ts";

export type Context = { request: IncomingMessage; deps: HandlerDeps };

const BODY_LIMIT = 4096;
const MAX_USERNAME = 64;

// Both files as they are right now, or null when either is invalid: fail closed.
type Files = { serverConfig: ServerConfig; secret: Buffer };

export const currentFiles = async (deps: HandlerDeps): Promise<Files | null> => {
  const serverConfig = await deps.config.current();
  const secret = await deps.secret.current();
  return serverConfig === null || secret === null ? null : { serverConfig, secret };
};

type Signed = { person: Person; key: Buffer; cookie: string };

// The person comes from a cookie nobody has verified yet, so it is looked up in a list,
// never as a property: "__proto__" is just a key nobody has.
const signedIn = (request: IncomingMessage, files: Files, now: number): Signed | null => {
  const cookie = cookieValue(request.headers.cookie);
  if (cookie === null) return null;
  const personOf = (personKey: string): Person | undefined =>
    files.serverConfig.people.find((item) => item.key === personKey);
  const keyFor = (personKey: string): Buffer | null => {
    const person = personOf(personKey);
    return person === undefined ? null : signingKey(files.secret, person);
  };
  const session = decodeSession(cookie, keyFor, now);
  if (session === null) return null;
  // Found by keyFor already, or the signature could not have been checked.
  const person = personOf(session.person);
  if (person === undefined) return null;
  return { person, key: signingKey(files.secret, person), cookie };
};

const withSession = async (
  { request, deps }: Context,
  run: (signed: Signed, files: Files) => Promise<Reply>,
): Promise<Reply> => {
  const files = await currentFiles(deps);
  if (files === null) return UNAVAILABLE;
  const signed = signedIn(request, files, deps.clock().getTime());
  return signed === null ? LOGIN_REFUSED : run(signed, files);
};

// A state-changing request: same-origin, and a small JSON body. The body's value, or the
// reply that refuses it.
const acceptPost = async (
  request: IncomingMessage,
): Promise<{ ok: true; value: unknown } | { ok: false; reply: Reply }> => {
  if (crossSiteProblem(request.headers) !== null) return { ok: false, reply: CROSS_SITE };
  const body = await readJson(request, BODY_LIMIT);
  return body.ok ? body : { ok: false, reply: BODY_REFUSED[body.status] };
};

const credentialsOf = (value: unknown): { username: string; password: string } | null => {
  if (!isObject(value)) return null;
  const keys = Object.keys(value).toSorted();
  if (keys.length !== 2 || keys[0] !== "password" || keys[1] !== "username") return null;
  const { username, password } = value;
  return typeof username === "string" && typeof password === "string"
    ? { username, password }
    : null;
};

// The order matters. A username too long, or one already locked, never reaches the hash
// queue, and only an attempt that went through the hash is counted, so the counts stay
// bounded by how many hashes fit in a window.
export const login = async ({ request, deps }: Context): Promise<Reply> => {
  const accepted = await acceptPost(request);
  if (!accepted.ok) return accepted.reply;
  const credentials = credentialsOf(accepted.value);
  if (credentials === null) return BODY_REFUSED[400];
  const { username, password } = credentials;

  if (username.length > MAX_USERNAME) {
    deps.log.event("login refused");
    return LOGIN_REFUSED;
  }
  const retryAfter = deps.limiter.retryAfter(username);
  if (retryAfter !== null) {
    deps.log.event("login limited");
    return tooManyAttempts(retryAfter);
  }
  const files = await currentFiles(deps);
  if (files === null) return UNAVAILABLE;

  // A username nobody has is checked against the dummy hash, so it takes as long.
  const checked = deps.queue.run(async () => {
    const person = findByUsername(files.serverConfig.people, username);
    const matches = await verifyPassword(password, person?.password ?? DUMMY_HASH);
    return person !== null && matches ? person : null;
  });
  if (checked === null) {
    deps.log.event("login queue full");
    return UNAVAILABLE;
  }
  const person = await checked;
  if (person === null) {
    deps.limiter.failed(username);
    deps.log.event("login refused");
    return LOGIN_REFUSED;
  }
  deps.limiter.succeeded(username);
  deps.log.event("login ok");
  const issuedAt = deps.clock().getTime();
  const value = encodeSession({ person: person.key, issuedAt }, signingKey(files.secret, person));
  return noContent({ "Set-Cookie": sessionCookie(value) });
};

const csrfHeader = (request: IncomingMessage): string | undefined => {
  const given = request.headers["x-csrf-token"];
  return typeof given === "string" ? given : undefined;
};

export const logout = async (context: Context): Promise<Reply> => {
  const accepted = await acceptPost(context.request);
  if (!accepted.ok) return accepted.reply;
  if (!isObject(accepted.value) || Object.keys(accepted.value).length > 0) {
    return BODY_REFUSED[400];
  }
  return withSession(context, ({ cookie, key }) =>
    Promise.resolve(
      csrfMatches(csrfHeader(context.request), csrfToken(cookie, key))
        ? noContent({ "Set-Cookie": clearedCookie() })
        : REFUSED,
    ),
  );
};

export const session = (context: Context): Promise<Reply> =>
  withSession(context, ({ person, key, cookie }, files) =>
    Promise.resolve(
      json(200, {
        person: person.key,
        accounts: visibleAccounts(files.serverConfig.config, person.key),
        csrf: csrfToken(cookie, key),
      }),
    ),
  );

const placeholder = async (deps: HandlerDeps, files: Files, keys: readonly string[]) => {
  const { config } = files.serverConfig;
  const counts = await countByAccount(deps.settings.dataDir, config, keys);
  return keys.map((key) => ({ key, bank: config.accounts[key].bank, transactions: counts[key] }));
};

export const accounts = (context: Context): Promise<Reply> =>
  withSession(context, async ({ person }, files) => {
    const visible = visibleAccounts(files.serverConfig.config, person.key);
    return json(200, { accounts: await placeholder(context.deps, files, visible) });
  });

// An account that is not theirs is answered exactly as one that does not exist.
export const oneAccount = (context: Context, key: string): Promise<Reply> =>
  withSession(context, async ({ person }, files) => {
    const visible = visibleAccounts(files.serverConfig.config, person.key);
    if (!visible.includes(key)) return NOT_FOUND;
    const [account] = await placeholder(context.deps, files, [key]);
    return json(200, account);
  });
