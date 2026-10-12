import { runAuth } from "./commands/auth.ts";
import type { Context, Deps } from "./context.ts";
import { makeClient } from "./enablebanking/client.ts";
import type { Environment } from "./env.ts";
import { SyncError } from "./errors.ts";
import { mintToken } from "./jwt.ts";
import { takeLock } from "./lock.ts";
import { makeLog } from "./log.ts";
import { loadStartup } from "./startup.ts";

const USAGE = "usage: auth <bank>";

// One command, from its arguments to its exit code. Everything it touches arrives in
// `deps`, so the tests run this very function against a fake bank.
export const main = async (
  argv: readonly string[],
  env: Environment,
  deps: Deps,
): Promise<number> => {
  const [command, ...rest] = argv;
  if (command !== "auth" || rest.length !== 1) throw new SyncError(USAGE);

  const { settings, config } = await loadStartup(env);
  const token = mintToken(settings.privateKey, settings.appId, deps.clock());
  const context: Context = {
    settings,
    config,
    client: makeClient(deps.fetch, token),
    deps,
    log: makeLog(deps.out),
  };

  const release = await takeLock(settings.stateDir, deps.pid, deps.isAlive);
  try {
    return await runAuth(context, rest[0]);
  } finally {
    await release();
  }
};
