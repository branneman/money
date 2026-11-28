// `npm run server`: the real server over the synthetic fixtures, with its state under
// tmp/dev/. Runs the same cli.ts the image does, as a child process.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { SECRET_FILE } from "../server/src/secret.ts";

const root = resolve(import.meta.dirname, "..");
const appDataDir = join(root, "tmp", "dev", "app-data");
const clientDir = join(root, "tmp", "dev", "client");
mkdirSync(appDataDir, { recursive: true });
mkdirSync(clientDir, { recursive: true });

// Only what the server needs: it refuses to start beside a bank credential, and a
// developer's shell may hold one.
const env = {
  PATH: process.env.PATH ?? "",
  CONFIG_PATH: join(root, "fixtures", "config.json"),
  DATA_DIR: join(root, "fixtures", "archive"),
  APP_DATA_DIR: appDataDir,
  CLIENT_DIR: clientDir,
  PORT: "8080",
  REVISION: "dev",
};

const cli = join(root, "server", "src", "cli.ts");
const run = (command: string): number | null =>
  spawnSync(process.execPath, [cli, command], { env, stdio: "inherit" }).status;

if (!existsSync(join(appDataDir, SECRET_FILE))) {
  console.log("no session secret yet, making one");
  const status = run("rotate-session-secret");
  if (status !== 0) process.exit(status ?? 1);
}
process.exit(run("serve") ?? 1);
