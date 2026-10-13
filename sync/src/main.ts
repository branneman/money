import { runAuth } from "./commands/auth.ts";
import { runBanks } from "./commands/banks.ts";
import { runImport } from "./commands/import.ts";
import { runStatus } from "./commands/status.ts";
import { runSync } from "./commands/sync.ts";
import type { Context, Deps } from "./context.ts";
import { makeClient } from "./enablebanking/client.ts";
import type { Environment } from "./env.ts";
import { SyncError } from "./errors.ts";
import { checkWritable } from "./inbox.ts";
import { mintToken } from "./jwt.ts";
import { takeLock } from "./lock.ts";
import { makeLog } from "./log.ts";
import { loadStartup } from "./startup.ts";

const SHOW_IBANS = "--show-ibans";
const WRITE = "--write";
const USAGE =
  "usage: auth <bank> [--show-ibans] | sync | status | banks <country> | import <format> <file> [--write]";

// import <format> <file>, with --write allowed only after them.
const isImport = (rest: readonly string[]): boolean =>
  (rest.length === 2 || (rest.length === 3 && rest[2] === WRITE)) &&
  !rest.slice(0, 2).some((argument) => argument.startsWith("--"));

// One command, from its arguments to its exit code. Everything it touches arrives in
// `deps`, so the tests run this very function against a fake bank.
export const main = async (
  argv: readonly string[],
  env: Environment,
  deps: Deps,
): Promise<number> => {
  const [command, ...rest] = argv;
  const known =
    (command === "auth" && (rest.length === 1 || (rest.length === 2 && rest[1] === SHOW_IBANS))) ||
    ((command === "sync" || command === "status") && rest.length === 0) ||
    (command === "banks" && rest.length === 1 && /^[A-Z]{2}$/.test(rest[0])) ||
    (command === "import" && isImport(rest));
  if (!known) throw new SyncError(USAGE);

  const { settings, config } = await loadStartup(env);
  const context: Context = {
    settings,
    config,
    // A token for each request: an authorisation can outlast any one token.
    client: makeClient(deps.fetch, () =>
      mintToken(settings.privateKey, settings.appId, deps.clock()),
    ),
    deps,
    log: makeLog(deps.out),
  };
  if (command === "status") return runStatus(context);
  if (command === "banks") return runBanks(context, rest[0]);
  // An import that only checks writes nothing, so it never waits for the nightly run.
  if (command === "import" && rest.length === 2) return runImport(context, rest[0], rest[1], false);

  // auth, sync and an import that writes all write the archive. One at a time.
  const release = await takeLock(settings.stateDir, deps.pid, deps.isAlive);
  try {
    await checkWritable(settings.dataDir);
    if (command === "auth") return await runAuth(context, rest[0], rest[1] === SHOW_IBANS);
    if (command === "import") return await runImport(context, rest[0], rest[1], true);
    return await runSync(context);
  } finally {
    await release();
  }
};
