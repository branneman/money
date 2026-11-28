import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { SECRET_FILE } from "./secret.ts";
import { makeServerWorld, PEOPLE, worldConfig } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

const UNAVAILABLE = JSON.stringify({ error: "unavailable" });
const CONFIG_INVALID = "configuration invalid, refusing requests";
const SECRET_INVALID = "session secret invalid, refusing requests";

const withWorld = async (run: (world: ServerWorld) => Promise<void>): Promise<void> => {
  const world = await makeServerWorld();
  try {
    await run(world);
  } finally {
    await world.close();
  }
};

const tryLogin = (world: ServerWorld) =>
  world.request("POST", "/api/login", {
    headers: { Origin: world.url, "Content-Type": "application/json" },
    body: JSON.stringify(PEOPLE.ana),
  });

const sessionStatus = async (world: ServerWorld, cookie: string): Promise<number> =>
  (await world.request("GET", "/api/session", { headers: { Cookie: cookie } })).status;

const signedIn = async (world: ServerWorld): Promise<string> => {
  const { cookie } = await world.login(PEOPLE.ana.username, PEOPLE.ana.password);
  assert.ok(cookie !== null);
  return cookie;
};

// The health check, the session of someone signed in before, and a login: all refused.
const assertRefusing = async (world: ServerWorld, cookie: string): Promise<void> => {
  const health = await world.request("GET", "/health");
  assert.equal(health.status, 503);
  assert.equal(health.body, UNAVAILABLE);
  const session = await world.request("GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(session.status, 503);
  assert.equal(session.body, UNAVAILABLE);
  const login = await tryLogin(world);
  assert.equal(login.status, 503);
  assert.equal(login.body, UNAVAILABLE);
  assert.equal(login.headers["set-cookie"], undefined);
};

const count = (world: ServerWorld, line: string): number =>
  world.output.filter((item) => item === line).length;

describe("reloading", { concurrency: true }, () => {
  test("a configuration that is invalid JSON is refused, logged once, and recovers", async () => {
    await withWorld(async (world) => {
      const cookie = await signedIn(world);
      await writeFile(world.configPath, "{ not json");
      await assertRefusing(world, cookie);
      await assertRefusing(world, cookie);
      assert.equal(count(world, CONFIG_INVALID), 1);
      await world.writeConfig(await worldConfig());
      assert.equal((await world.request("GET", "/health")).status, 200);
      assert.equal(await sessionStatus(world, cookie), 200);
      assert.equal((await tryLogin(world)).status, 204);
      assert.equal(count(world, CONFIG_INVALID), 1);
    });
  });

  test("a configuration replaced by a directory is refused with 503, logged once", async () => {
    await withWorld(async (world) => {
      const cookie = await signedIn(world);
      await rm(world.configPath);
      await mkdir(world.configPath);
      await assertRefusing(world, cookie);
      await assertRefusing(world, cookie);
      assert.equal(count(world, CONFIG_INVALID), 1);
      assert.ok(!world.output.some((line) => line.startsWith("failed")));
    });
  });

  test("a secret file replaced by a short one is refused, logged once, and recovers", async () => {
    await withWorld(async (world) => {
      const cookie = await signedIn(world);
      await writeFile(join(world.appDataDir, SECRET_FILE), "too short\n");
      await assertRefusing(world, cookie);
      await assertRefusing(world, cookie);
      assert.equal(count(world, SECRET_INVALID), 1);
      // A valid secret is a new one, and the cookie signed under the old one is gone.
      await world.rotateSecret();
      assert.equal((await world.request("GET", "/health")).status, 200);
      assert.equal((await tryLogin(world)).status, 204);
      assert.equal(await sessionStatus(world, cookie), 401);
      assert.equal(count(world, SECRET_INVALID), 1);
    });
  });
});
