import { runAuth } from "./commands/auth.ts";
import { runBanks } from "./commands/banks.ts";
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

const USAGE = "usage: auth <bank> | sync | status | banks <country>";

// One command, from its arguments to its exit code. Everything it touches arrives in
// `deps`, so the tests run this very function against a fake bank.
export const main = async (
  argv: readonly string[],
  env: Environment,
  deps: Deps,
): Promise<number> => {
  const [command, ...rest] = argv;
  const known =
    (command === "auth" && rest.length === 1) ||
    ((command === "sync" || command === "status") && rest.length === 0) ||
    (command === "banks" && rest.length === 1 && /^[A-Z]{2}$/.test(rest[0]));
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

  // auth and sync both write the archive. One at a time.
  const release = await takeLock(settings.stateDir, deps.pid, deps.isAlive);
  try {
    await checkWritable(settings.dataDir);
    return command === "auth" ? await runAuth(context, rest[0]) : await runSync(context);
  } finally {
    await release();
  }
};
