import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { aConfig } from "@money/shared/testing";

import { SyncError } from "./errors.ts";
import { loadStartup } from "./startup.ts";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});

let dir = "";
let env: Record<string, string> = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-startup-"));
  await mkdir(join(dir, "data"));
  await mkdir(join(dir, "state"));
  await writeFile(join(dir, "config.json"), JSON.stringify(aConfig()));
  env = {
    EB_APP_ID: "00000000-0000-4000-8000-00000000aaaa",
    EB_PRIVATE_KEY: Buffer.from(pem).toString("base64"),
    EB_REDIRECT_URL: "https://localhost/auth-callback",
    CONFIG_PATH: join(dir, "config.json"),
    DATA_DIR: join(dir, "data"),
    STATE_DIR: join(dir, "state"),
  };
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const failure = async (): Promise<string> => {
  try {
    await loadStartup(env);
  } catch (error) {
    assert.ok(error instanceof SyncError);
    return error.message;
  }
  return assert.fail("startup should have failed");
};

test("a complete setup gives the settings and the configuration", async () => {
  const { settings, config } = await loadStartup(env);
  assert.equal(settings.dataDir, join(dir, "data"));
  assert.deepEqual(config, aConfig());
});

test("a problem in the environment stops startup before anything is read", async () => {
  delete env.EB_APP_ID;
  env.CONFIG_PATH = join(dir, "absent.json");
  assert.equal(await failure(), "EB_APP_ID is not set");
});

test("a directory that does not exist is reported, and never created", async () => {
  env.DATA_DIR = join(dir, "no-data");
  env.STATE_DIR = join(dir, "config.json");
  assert.equal(
    await failure(),
    "DATA_DIR does not name an existing directory\nSTATE_DIR does not name an existing directory",
  );
  await assert.rejects(mkdir(join(dir, "no-data", "x")), { code: "ENOENT" });
});

test("a missing configuration file is reported", async () => {
  env.CONFIG_PATH = join(dir, "absent.json");
  assert.equal(await failure(), "CONFIG_PATH does not name a file");
});

test("a configuration file that is not JSON is reported without quoting it", async () => {
  await writeFile(join(dir, "config.json"), '{ "banks": NL00BNKA0000000001');
  assert.equal(await failure(), "the configuration file is not valid JSON");
});

test("every problem in the configuration file is reported", async () => {
  const broken = { ...aConfig(), accounts: { "bnka-current": { bank: "nowhere" } } };
  await writeFile(join(dir, "config.json"), JSON.stringify(broken));
  assert.equal(
    await failure(),
    "configuration: accounts.bnka-current: its bank is not configured\n" +
      "configuration: accounts.bnka-current: needs an iban or an import_id",
  );
});
