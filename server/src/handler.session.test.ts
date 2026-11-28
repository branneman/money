import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Config } from "@money/shared";

import { hashPassword } from "./auth/password.ts";
import { clearedCookie, encodeSession, SESSION_COOKIE, SESSION_MS } from "./auth/session.ts";
import { makeServerWorld, PEOPLE, REVISION, worldConfig } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

const REFUSED = JSON.stringify({ error: "login refused" });

const withWorld = async (run: (world: ServerWorld) => Promise<void>): Promise<void> => {
  const world = await makeServerWorld();
  try {
    await run(world);
  } finally {
    await world.close();
  }
};

const loggedIn = async (world: ServerWorld, person: "ana" | "ben"): Promise<string> => {
  const { status, cookie } = await world.login(PEOPLE[person].username, PEOPLE[person].password);
  assert.equal(status, 204);
  assert.ok(cookie !== null);
  return cookie;
};

const sessionStatus = async (world: ServerWorld, cookie: string): Promise<number> => {
  const response = await world.request("GET", "/api/session", { headers: { Cookie: cookie } });
  if (response.status === 401) assert.equal(response.body, REFUSED);
  return response.status;
};

const changed = async (edit: (config: Config) => void): Promise<Config> => {
  const config = structuredClone(await worldConfig());
  edit(config);
  return config;
};

describe("sessions", { concurrency: true }, () => {
  test("a fresh cookie gives the person, the accounts they may see and a CSRF token", async () => {
    await withWorld(async (world) => {
      const session = await world.session(await loggedIn(world, "ana"));
      assert.equal(session.person, "ana");
      assert.deepEqual(session.accounts, ["bnka-shared", "bnka-solo"]);
      assert.match(session.csrf, /^[A-Za-z0-9_-]{43}$/);
    });
  });

  test("no cookie is 401", async () => {
    await withWorld(async (world) => {
      const response = await world.request("GET", "/api/session");
      assert.equal(response.status, 401);
      assert.equal(response.body, REFUSED);
    });
  });

  test("a cookie is refused at seven days, and not a moment before", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      world.clock.advance(SESSION_MS - 1);
      assert.equal(await sessionStatus(world, cookie), 200);
      world.clock.advance(1);
      assert.equal(await sessionStatus(world, cookie), 401);
    });
  });

  test("a tampered cookie is refused", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const [name, value] = cookie.split("=");
      const flipped = value[3] === "A" ? "B" : "A";
      const tampered = `${name}=${value.slice(0, 3)}${flipped}${value.slice(4)}`;
      assert.equal(await sessionStatus(world, tampered), 401);
    });
  });

  test("a cookie naming __proto__ or constructor is 401, not 500", async () => {
    await withWorld(async (world) => {
      const issuedAt = world.clock.now().getTime();
      for (const person of ["__proto__", "constructor", "toString"]) {
        const value = encodeSession({ person, issuedAt }, Buffer.alloc(32, 9));
        assert.equal(await sessionStatus(world, `${SESSION_COOKIE}=${value}`), 401);
      }
    });
  });

  test("after the secret is rotated, an old cookie is refused and a new login works", async () => {
    await withWorld(async (world) => {
      const old = await loggedIn(world, "ana");
      await world.rotateSecret();
      assert.equal(await sessionStatus(world, old), 401);
      assert.equal(await sessionStatus(world, await loggedIn(world, "ana")), 200);
    });
  });

  test("a new password for one person ends their sessions and not the other's", async () => {
    await withWorld(async (world) => {
      const ana = await loggedIn(world, "ana");
      const ben = await loggedIn(world, "ben");
      const password = await hashPassword("a new password for ana", Buffer.alloc(16, 3));
      await world.writeConfig(
        await changed((config) => {
          config.people = { ...config.people, ana: { username: PEOPLE.ana.username, password } };
        }),
      );
      assert.equal(await sessionStatus(world, ana), 401);
      assert.equal(await sessionStatus(world, ben), 200);
    });
  });

  test("a new username for one person ends their sessions and not the other's", async () => {
    await withWorld(async (world) => {
      const ana = await loggedIn(world, "ana");
      const ben = await loggedIn(world, "ben");
      await world.writeConfig(
        await changed((config) => {
          const entry = config.people?.ana;
          assert.ok(entry !== undefined);
          config.people = { ...config.people, ana: { ...entry, username: "tw-ana-Nw5t2Hb8" } };
        }),
      );
      assert.equal(await sessionStatus(world, ana), 401);
      assert.equal(await sessionStatus(world, ben), 200);
    });
  });

  test("a person removed from the configuration is refused on their next request", async () => {
    await withWorld(async (world) => {
      const ana = await loggedIn(world, "ana");
      const ben = await loggedIn(world, "ben");
      await world.writeConfig(
        await changed((config) => {
          const { ana: kept } = config.people ?? {};
          config.people = { ana: kept };
          config.accounts["bnka-shared"].owners = ["ana"];
        }),
      );
      assert.equal(await sessionStatus(world, ben), 401);
      assert.equal(await sessionStatus(world, ana), 200);
    });
  });

  test("logout with the person's token answers 204 and clears the cookie", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const { csrf } = await world.session(cookie);
      const response = await world.request("POST", "/api/logout", {
        headers: {
          Cookie: cookie,
          Origin: world.url,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
        },
        body: "{}",
      });
      assert.equal(response.status, 204);
      assert.deepEqual(response.headers["set-cookie"], [clearedCookie()]);
    });
  });

  test("/health answers 200, and /version names the revision", async () => {
    await withWorld(async (world) => {
      const health = await world.request("GET", "/health");
      assert.equal(health.status, 200);
      assert.equal(health.body, JSON.stringify({ status: "ok" }));
      const version = await world.request("GET", "/version");
      assert.equal(version.status, 200);
      assert.deepEqual(JSON.parse(version.body), { revision: REVISION });
    });
  });
});
