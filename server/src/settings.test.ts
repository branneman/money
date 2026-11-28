import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { directoryProblems, readSettings } from "./settings.ts";
import type { Settings } from "./settings.ts";

const complete: Record<string, string> = {
  CONFIG_PATH: "/etc/money/config.json",
  DATA_DIR: "/archive",
  APP_DATA_DIR: "/app-data",
  CLIENT_DIR: "/app/client",
  PORT: "8080",
  REVISION: "abc123",
};

test("a complete environment gives the settings", () => {
  assert.deepEqual(readSettings(complete), {
    ok: true,
    settings: {
      configPath: "/etc/money/config.json",
      dataDir: "/archive",
      appDataDir: "/app-data",
      clientDir: "/app/client",
      port: 8080,
      revision: "abc123",
    },
  });
});

for (const name of Object.keys(complete)) {
  test(`${name} missing is a problem`, () => {
    const rest = Object.fromEntries(Object.entries(complete).filter(([key]) => key !== name));
    assert.deepEqual(readSettings(rest), { ok: false, problems: [`${name} is not set`] });
  });
  test(`${name} empty is a problem`, () => {
    assert.deepEqual(readSettings({ ...complete, [name]: "" }), {
      ok: false,
      problems: [`${name} is not set`],
    });
  });
}

test("every problem is reported at once", () => {
  const result = readSettings({});
  assert.equal(result.ok, false);
  assert.equal(result.ok ? 0 : result.problems.length, 6);
});

for (const port of ["0", "65536", "80a", "-1", "8080.5", " 80"]) {
  test(`PORT ${JSON.stringify(port)} is refused`, () => {
    assert.deepEqual(readSettings({ ...complete, PORT: port }), {
      ok: false,
      problems: ["PORT must be a port number"],
    });
  });
}

test("the ends of the port range are accepted", () => {
  for (const port of ["1", "65535"]) {
    const result = readSettings({ ...complete, PORT: port });
    assert.equal(result.ok && result.settings.port, Number(port));
  }
});

test("EB_PRIVATE_KEY, EB_APP_ID and STATE_DIR each stop the server, and their values are not printed", () => {
  const result = readSettings({
    ...complete,
    EB_PRIVATE_KEY: "secret-key-value",
    EB_APP_ID: "secret-app-value",
    STATE_DIR: "/secret/state/path",
  });
  assert.deepEqual(result, {
    ok: false,
    problems: [
      "EB_PRIVATE_KEY must not reach the server",
      "EB_APP_ID must not reach the server",
      "STATE_DIR must not reach the server",
    ],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("an EB_ variable stops the server even when empty", () => {
  const result = readSettings({ ...complete, EB_REDIRECT_URL: "" });
  assert.deepEqual(result, { ok: false, problems: ["EB_REDIRECT_URL must not reach the server"] });
});

test("a variable that only resembles EB_ is not refused", () => {
  assert.equal(readSettings({ ...complete, WEB_X: "1", EBX: "1" }).ok, true);
});

const withDirectories = async (
  run: (root: string, settings: Settings) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "settings-test-"));
  try {
    await Promise.all(["data", "app", "client"].map((name) => mkdir(join(root, name))));
    await run(root, {
      configPath: join(root, "config.json"),
      dataDir: join(root, "data"),
      appDataDir: join(root, "app"),
      clientDir: join(root, "client"),
      port: 8080,
      revision: "r",
    });
  } finally {
    // A test may have made the directory unwritable, which would stop the removal.
    await chmod(join(root, "app"), 0o700);
    await rm(root, { recursive: true, force: true });
  }
};

test("existing directories give no problem", async () => {
  await withDirectories(async (_root, settings) => {
    assert.deepEqual(await directoryProblems(settings), []);
  });
});

test("an absent path is a problem for each directory", async () => {
  await withDirectories(async (root, settings) => {
    const missing = join(root, "nope");
    assert.deepEqual(
      await directoryProblems({
        ...settings,
        dataDir: missing,
        appDataDir: missing,
        clientDir: missing,
      }),
      [
        "DATA_DIR does not name an existing directory",
        "APP_DATA_DIR does not name an existing directory",
        "CLIENT_DIR does not name an existing directory",
      ],
    );
    await assert.rejects(stat(missing), { code: "ENOENT" });
  });
});

test("a file in place of a directory is a problem", async () => {
  await withDirectories(async (root, settings) => {
    const file = join(root, "file");
    await writeFile(file, "x");
    assert.deepEqual(await directoryProblems({ ...settings, clientDir: file }), [
      "CLIENT_DIR does not name an existing directory",
    ]);
  });
});

test("an APP_DATA_DIR this user cannot write is a problem", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root can write to a 0o500 directory, so there is nothing to assert");
    return;
  }
  await withDirectories(async (_root, settings) => {
    await chmod(settings.appDataDir, 0o500);
    assert.deepEqual(await directoryProblems(settings), [
      "APP_DATA_DIR cannot be written by this user",
    ]);
  });
});
