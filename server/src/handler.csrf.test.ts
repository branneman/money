import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { makeServerWorld, PEOPLE } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

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

const logout = (world: ServerWorld, cookie: string, headers: Record<string, string>) =>
  world.request("POST", "/api/logout", {
    headers: { Origin: world.url, "Content-Type": "application/json", Cookie: cookie, ...headers },
    body: "{}",
  });

const stillSignedIn = async (world: ServerWorld, cookie: string): Promise<void> => {
  const response = await world.request("GET", "/api/session", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
};

describe("CSRF", { concurrency: true }, () => {
  test("logout with the right token clears the cookie", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const { csrf } = await world.session(cookie);
      const response = await logout(world, cookie, { "X-CSRF-Token": csrf });
      assert.equal(response.status, 204);
      assert.match(String(response.headers["set-cookie"]), /^__Host-session=; Max-Age=0/);
    });
  });

  test("logout without the token, or with a wrong one, is 403 and changes nothing", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const wrong: Record<string, string>[] = [
        {},
        { "X-CSRF-Token": "" },
        { "X-CSRF-Token": "x".repeat(43) },
      ];
      for (const headers of wrong) {
        const response = await logout(world, cookie, headers);
        assert.equal(response.status, 403);
        assert.equal(response.body, JSON.stringify({ error: "refused" }));
        assert.equal(response.headers["set-cookie"], undefined);
      }
      await stillSignedIn(world, cookie);
    });
  });

  test("logout with another person's token is 403", async () => {
    await withWorld(async (world) => {
      const ana = await loggedIn(world, "ana");
      const ben = await loggedIn(world, "ben");
      const { csrf } = await world.session(ben);
      const response = await logout(world, ana, { "X-CSRF-Token": csrf });
      assert.equal(response.status, 403);
      await stillSignedIn(world, ana);
      await stillSignedIn(world, ben);
    });
  });

  test("logout with the token of an earlier cookie of the same person is 403", async () => {
    await withWorld(async (world) => {
      const first = await loggedIn(world, "ana");
      const old = await world.session(first);
      world.clock.advance(1000);
      const second = await loggedIn(world, "ana");
      assert.notEqual(first, second);
      const response = await logout(world, second, { "X-CSRF-Token": old.csrf });
      assert.equal(response.status, 403);
      await stillSignedIn(world, second);
    });
  });

  test("logout without a session is 401, and a token is not enough", async () => {
    await withWorld(async (world) => {
      const response = await world.request("POST", "/api/logout", {
        headers: { Origin: world.url, "Content-Type": "application/json", "X-CSRF-Token": "x" },
        body: "{}",
      });
      assert.equal(response.status, 401);
    });
  });

  test("a cross-site logout is 403 whatever the token, and changes nothing", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const { csrf } = await world.session(cookie);
      const attempts: Record<string, Record<string, string>> = {
        "foreign Origin": { Origin: "https://evil.example.test" },
        "Origin null": { Origin: "null" },
        "Sec-Fetch-Site cross-site": { "Sec-Fetch-Site": "cross-site" },
      };
      for (const [name, headers] of Object.entries(attempts)) {
        const response = await logout(world, cookie, { "X-CSRF-Token": csrf, ...headers });
        assert.equal(response.status, 403, name);
        assert.equal(response.headers["set-cookie"], undefined, name);
      }
      // No Origin at all: the helper always sends one, so this request is made by hand.
      const none = await world.request("POST", "/api/logout", {
        headers: { "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": csrf },
        body: "{}",
      });
      assert.equal(none.status, 403);
      assert.equal(none.headers["set-cookie"], undefined);
      await stillSignedIn(world, cookie);
    });
  });

  test("a cross-site login is 403 and sets no cookie, even with the right password", async () => {
    await withWorld(async (world) => {
      const body = JSON.stringify(PEOPLE.ana);
      const json = { "Content-Type": "application/json" };
      const attempts: Record<string, Record<string, string>> = {
        "foreign Origin": { ...json, Origin: "https://evil.example.test" },
        "no Origin": json,
        "Sec-Fetch-Site cross-site": { ...json, Origin: world.url, "Sec-Fetch-Site": "cross-site" },
      };
      for (const [name, headers] of Object.entries(attempts)) {
        const response = await world.request("POST", "/api/login", { headers, body });
        assert.equal(response.status, 403, name);
        assert.equal(response.headers["set-cookie"], undefined, name);
      }
      assert.ok(!world.output.some((line) => line.startsWith("login ")));
    });
  });

  test("logout and login with Content-Type text/plain are 415 and change nothing", async () => {
    await withWorld(async (world) => {
      const cookie = await loggedIn(world, "ana");
      const { csrf } = await world.session(cookie);
      const out = await logout(world, cookie, {
        "Content-Type": "text/plain",
        "X-CSRF-Token": csrf,
      });
      assert.equal(out.status, 415);
      assert.equal(out.headers["set-cookie"], undefined);
      const attempt = await world.request("POST", "/api/login", {
        headers: { Origin: world.url, "Content-Type": "text/plain" },
        body: JSON.stringify(PEOPLE.ben),
      });
      assert.equal(attempt.status, 415);
      assert.equal(attempt.headers["set-cookie"], undefined);
      await stillSignedIn(world, cookie);
    });
  });
});
