// The server's one request handler: routes as the spec's table, the headers every response
// carries, one log line per request, and a 500 that says only which kind of error it was.
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

import { accounts, currentFiles, login, logout, oneAccount, session } from "./api.ts";
import type { Context } from "./api.ts";
import type { makeLimiter } from "./auth/limiter.ts";
import type { makeQueue } from "./auth/queue.ts";
import { NO_STORE, SECURITY_HEADERS } from "./http/headers.ts";
import { cacheControlOf, contentTypeOf, resolveStatic } from "./http/static.ts";
import { makeLive } from "./live.ts";
import type { Live } from "./live.ts";
import type { Log } from "./log.ts";
import { FAILED, json, methodNotAllowed, NOT_FOUND, UNAVAILABLE } from "./reply.ts";
import type { Reply } from "./reply.ts";
import { parseSecret, SECRET_FILE } from "./secret.ts";
import { loadServerConfig } from "./server-config.ts";
import type { ServerConfig } from "./server-config.ts";
import type { Settings } from "./settings.ts";

export type HandlerDeps = {
  settings: Settings;
  clock: () => Date;
  log: Log;
  config: Live<ServerConfig>;
  secret: Live<Buffer>;
  limiter: ReturnType<typeof makeLimiter>;
  queue: ReturnType<typeof makeQueue>;
};

// The configuration and the secret, each read again when its file changes. A file that
// goes bad is one log line, and every request that needs it is refused until it is fixed.
export const watchFiles = (
  settings: Settings,
  log: Log,
): { config: Live<ServerConfig>; secret: Live<Buffer> } => ({
  config: makeLive(
    settings.configPath,
    (text) => {
      const loaded = loadServerConfig(text);
      return loaded.ok ? loaded.value : null;
    },
    () => log.event("configuration invalid, refusing requests"),
  ),
  secret: makeLive(join(settings.appDataDir, SECRET_FILE), parseSecret, () =>
    log.event("session secret invalid, refusing requests"),
  ),
});

const health = async ({ deps }: Context): Promise<Reply> =>
  (await currentFiles(deps)) === null ? UNAVAILABLE : json(200, { status: "ok" });

const version = ({ deps }: Context): Promise<Reply> =>
  Promise.resolve(json(200, { revision: deps.settings.revision }));

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  ["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(String(error.code));

// Opened once and checked through the same handle, so what is served is the regular file
// that was checked: a directory, even one named like a file, is not found.
const staticFile = async ({ deps }: Context, url: string): Promise<Reply> => {
  const path = resolveStatic(deps.settings.clientDir, url);
  const type = path === null ? null : contentTypeOf(path);
  if (path === null || type === null) return NOT_FOUND;
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if (isMissing(error)) return NOT_FOUND;
    throw error;
  }
  try {
    if (!(await file.stat()).isFile()) return NOT_FOUND;
    const body = await file.readFile();
    return {
      status: 200,
      headers: {
        "Content-Type": type,
        "Cache-Control": cacheControlOf(deps.settings.clientDir, path),
      },
      body,
    };
  } finally {
    await file.close();
  }
};

type Route = {
  // What the log line names: a pattern, never the path that was asked for.
  pattern: string;
  // The one method the route takes; null for a path under /api/ that is no route at all.
  method: string | null;
  run: (context: Context) => Promise<Reply>;
};

const ACCOUNT_PATH = /^\/api\/accounts\/([^/]+)$/;
const STATIC = "/*";

const routeOf = (url: string): Route => {
  const path = url.split("?", 1)[0];
  switch (path) {
    case "/health":
      return { pattern: path, method: "GET", run: health };
    case "/version":
      return { pattern: path, method: "GET", run: version };
    case "/api/login":
      return { pattern: path, method: "POST", run: login };
    case "/api/logout":
      return { pattern: path, method: "POST", run: logout };
    case "/api/session":
      return { pattern: path, method: "GET", run: session };
    case "/api/accounts":
      return { pattern: path, method: "GET", run: accounts };
  }
  const account = ACCOUNT_PATH.exec(path);
  if (account !== null) {
    const key = account[1];
    return {
      pattern: "/api/accounts/:key",
      method: "GET",
      run: (context) => oneAccount(context, key),
    };
  }
  // Never the client's index.html: an API path that does not exist says so.
  if (path === "/api" || path.startsWith("/api/")) {
    return { pattern: "/api/*", method: null, run: () => Promise.resolve(NOT_FOUND) };
  }
  return { pattern: STATIC, method: "GET", run: (context) => staticFile(context, url) };
};

// The security headers go last, so no route can loosen them.
const send = (response: ServerResponse, reply: Reply, pattern: string): void => {
  const headers: Record<string, string> = {
    ...reply.headers,
    ...(pattern === STATIC ? {} : NO_STORE),
    ...SECURITY_HEADERS,
  };
  if (reply.status === 204) {
    response.writeHead(reply.status, headers).end();
    return;
  }
  headers["Content-Length"] = String(Buffer.byteLength(reply.body));
  response.writeHead(reply.status, headers).end(reply.body);
};

const errorClass = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

export const makeHandler =
  (deps: HandlerDeps) =>
  async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const started = deps.clock().getTime();
    // Node's parser gives a server's request both; only a client's lacks them.
    const method = request.method ?? "";
    const route = routeOf(request.url ?? "");
    let status = FAILED.status;
    try {
      const reply =
        route.method === null || route.method === method
          ? await route.run({ request, deps })
          : methodNotAllowed(route.method);
      send(response, reply, route.pattern);
      status = reply.status;
    } catch (error) {
      deps.log.event(`failed ${errorClass(error)}`);
      if (response.headersSent) response.destroy();
      else send(response, FAILED, route.pattern);
    }
    deps.log.request(method, route.pattern, status, deps.clock().getTime() - started);
  };
