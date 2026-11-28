// The server's three commands, from their arguments to an exit code, or to a running
// server. Everything they touch outside their arguments arrives in `deps`, so the tests
// run this very function.
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";

import type { Environment } from "@money/shared";
import { codeOf, isRefused } from "@money/shared/node";

import { hashPassword, MIN_PASSWORD_LENGTH } from "./auth/password.ts";
import { makeHandler } from "./handler.ts";
import { makeLog } from "./log.ts";
import { parseSecret, rotateSecret, SECRET_FILE } from "./secret.ts";
import { makeHandlerDeps, makeServer } from "./serve.ts";
import { loadServerConfig } from "./server-config.ts";
import { directoryProblems, readSettings, writableDirectoryProblem } from "./settings.ts";
import type { Settings } from "./settings.ts";

export type Running = { port: number; close(): Promise<void> };

export type Deps = {
  clock: () => Date;
  out: (line: string) => void;
  randomBytes: (size: number) => Buffer;
  isTerminal: boolean;
  readHidden: (prompt: string) => Promise<string>;
  // Takes the server itself, not a handler: `serve` has already put the net under it that
  // catches a malformed request and a handler that fails.
  listen: (server: Server, port: number) => Promise<Running>;
};

export type Outcome = { exit: number } | { running: Running };

const USAGE = "usage: serve | hash-password | rotate-session-secret";

const NO_SECRET = "the session secret is missing or invalid. Run: money rotate-session-secret";

const fail = (deps: Deps, problems: readonly string[]): Outcome => {
  for (const problem of problems) deps.out(problem);
  return { exit: 1 };
};

// The file's text, or null when there is no file there. A file this user may not read is a
// problem to report; anything else is a fault to fail on.
const readText = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (["ENOENT", "EISDIR", "ENOTDIR"].includes(codeOf(error) ?? "")) return null;
    throw error;
  }
};

const startupProblems = async (settings: Settings): Promise<string[]> => {
  const problems = await directoryProblems(settings);

  const secret = await readText(join(settings.appDataDir, SECRET_FILE));
  if (secret === null || parseSecret(secret) === null) problems.push(NO_SECRET);

  try {
    const config = await readText(settings.configPath);
    if (config === null) problems.push("CONFIG_PATH does not name a file");
    else {
      const loaded = loadServerConfig(config);
      if (!loaded.ok) problems.push(...loaded.problems);
    }
  } catch (error) {
    if (!isRefused(error)) throw error;
    problems.push("CONFIG_PATH names a file this user cannot read");
  }
  return problems;
};

const serve = async (env: Environment, deps: Deps): Promise<Outcome> => {
  const read = readSettings(env);
  if (!read.ok) return fail(deps, read.problems);
  const { settings } = read;

  const problems = await startupProblems(settings);
  if (problems.length > 0) return fail(deps, problems);

  const log = makeLog(deps.out);
  const handler = makeHandler(makeHandlerDeps(settings, deps.clock, log));
  const running = await deps.listen(makeServer(handler, log), settings.port);
  log.event(`serving port=${running.port} revision=${settings.revision}`);
  return { running };
};

const hashPasswordCommand = async (deps: Deps): Promise<Outcome> => {
  const password = await deps.readHidden("password: ");
  // Asked twice only where a person is typing; a pipe has nobody to mistype.
  if (deps.isTerminal && (await deps.readHidden("again: ")) !== password) {
    return fail(deps, ["the two passwords differ"]);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return fail(deps, [`a password needs at least ${MIN_PASSWORD_LENGTH} characters`]);
  }
  deps.out(await hashPassword(password, deps.randomBytes(16)));
  return { exit: 0 };
};

const rotateCommand = async (env: Environment, deps: Deps): Promise<Outcome> => {
  const dir = env.APP_DATA_DIR;
  if (dir === undefined || dir === "") return fail(deps, ["APP_DATA_DIR is not set"]);
  const problems = await writableDirectoryProblem("APP_DATA_DIR", dir);
  if (problems.length > 0) return fail(deps, problems);
  await rotateSecret(dir, deps.randomBytes);
  deps.out("session secret rotated");
  return { exit: 0 };
};

export const main = async (
  argv: readonly string[],
  env: Environment,
  deps: Deps,
): Promise<Outcome> => {
  const [command, ...rest] = argv;
  if (rest.length === 0) {
    if (command === "serve") return serve(env, deps);
    if (command === "hash-password") return hashPasswordCommand(deps);
    if (command === "rotate-session-secret") return rotateCommand(env, deps);
  }
  return fail(deps, [USAGE]);
};
