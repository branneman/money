import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { makeServerWorld, PEOPLE } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

const MINUTE = 60 * 1000;
const REFUSED = JSON.stringify({ error: "login refused" });
const LIMITED = JSON.stringify({ error: "too many attempts" });

const withWorld = async (run: (world: ServerWorld) => Promise<void>): Promise<void> => {
  const world = await makeServerWorld();
  try {
    await run(world);
  } finally {
    await world.close();
  }
};

const attempt = (world: ServerWorld, username: string, password: string) =>
  world.request("POST", "/api/login", {
    headers: { Origin: world.url, "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

const failTimes = async (world: ServerWorld, username: string, times: number): Promise<void> => {
  for (let index = 0; index < times; index += 1) {
    const response = await attempt(world, username, "not the password");
    assert.equal(response.status, 401, `failure ${index + 1} of ${username.length} characters`);
  }
};

// Every test has a world of its own, so they may run side by side: each hash is a quarter
// of a second, and run one after another they would add up.
describe("login", { concurrency: true }, () => {
  test("a login answers 204 with the session cookie, and exactly its attributes", async () => {
    await withWorld(async (world) => {
      const response = await attempt(world, PEOPLE.ana.username, PEOPLE.ana.password);
      assert.equal(response.status, 204);
      assert.equal(response.body, "");
      const cookies = response.headers["set-cookie"] ?? [];
      assert.equal(cookies.length, 1);
      assert.match(
        cookies[0],
        /^__Host-session=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Max-Age=604800; Path=\/; Secure; HttpOnly; SameSite=Strict$/,
      );
      assert.deepEqual(world.output, [
        "login ok",
        "request method=POST route=/api/login status=204 ms=0",
      ]);
    });
  });

  test("a wrong password and an unknown username get the same status and body", async () => {
    await withWorld(async (world) => {
      const wrong = await attempt(world, PEOPLE.ana.username, "not the password");
      const unknown = await attempt(world, "tw-nobody-Zz0", PEOPLE.ana.password);
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrong.body, REFUSED);
      assert.equal(unknown.body, REFUSED);
      assert.equal(wrong.headers["set-cookie"], undefined);
      assert.equal(unknown.headers["set-cookie"], undefined);
    });
  });

  test("a username in another case, with a space before it, or a person's key is refused", async () => {
    await withWorld(async (world) => {
      for (const username of [
        PEOPLE.ana.username.toUpperCase(),
        ` ${PEOPLE.ana.username}`,
        "ana",
      ]) {
        const response = await attempt(world, username, PEOPLE.ana.password);
        assert.equal(response.status, 401);
        assert.equal(response.body, REFUSED);
      }
    });
  });

  test("the sixth failure is 429, for a real username and an unknown one alike", async () => {
    await withWorld(async (world) => {
      for (const username of [PEOPLE.ana.username, "tw-nobody-Zz0"]) {
        await failTimes(world, username, 5);
        // Even the right password: the username is locked, not the password wrong.
        const sixth = await attempt(world, username, PEOPLE.ana.password);
        assert.equal(sixth.status, 429);
        assert.equal(sixth.headers["retry-after"], "900");
        assert.equal(sixth.body, LIMITED);
      }
      const other = await attempt(world, PEOPLE.ben.username, PEOPLE.ben.password);
      assert.equal(other.status, 204);
      assert.ok(world.output.includes("login limited"));
    });
  });

  test("a success clears the count", async () => {
    await withWorld(async (world) => {
      await failTimes(world, PEOPLE.ana.username, 4);
      assert.equal((await attempt(world, PEOPLE.ana.username, PEOPLE.ana.password)).status, 204);
      await failTimes(world, PEOPLE.ana.username, 5);
      assert.equal((await attempt(world, PEOPLE.ana.username, "not the password")).status, 429);
    });
  });

  test("a username locked while its logins wait for the hash is not checked again", async () => {
    await withWorld(async (world) => {
      await failTimes(world, PEOPLE.ana.username, 4);
      // One runs and eight wait: exactly what the queue takes. The one that runs is the
      // fifth failure, and locks the username before any of the eight is checked.
      const burst = await Promise.all(
        Array.from({ length: 9 }, () => attempt(world, PEOPLE.ana.username, "not the password")),
      );
      const statuses = burst.map((response) => response.status).toSorted();
      assert.deepEqual(statuses, [401, 429, 429, 429, 429, 429, 429, 429, 429]);
      for (const response of burst.filter((item) => item.status === 429)) {
        assert.match(String(response.headers["retry-after"]), /^\d+$/);
        assert.equal(response.body, LIMITED);
      }
      // Five checks of the password in all, and every other attempt answered without one.
      assert.equal(world.output.filter((line) => line === "login refused").length, 5);
      assert.equal(world.output.filter((line) => line === "login limited").length, 8);
    });
  });

  test("20 simultaneous logins for a locked username are all 429, and none waits for a hash", async () => {
    await withWorld(async (world) => {
      await failTimes(world, PEOPLE.ana.username, 5);
      const started = performance.now();
      const burst = await Promise.all(
        Array.from({ length: 20 }, () => attempt(world, PEOPLE.ana.username, PEOPLE.ana.password)),
      );
      const elapsed = performance.now() - started;
      assert.deepEqual(
        burst.map((response) => response.status),
        Array.from({ length: 20 }, () => 429),
      );
      // One hash takes about a quarter of a second; twenty queued would take seconds.
      assert.ok(elapsed < 150, `took ${elapsed} ms`);
    });
  });

  test("12 simultaneous logins for unknown usernames: some 503, the rest 401, and each 401 is one failure", async () => {
    await withWorld(async (world) => {
      const usernames = Array.from({ length: 12 }, (_, index) => `tw-unknown-${index}`);
      const burst = await Promise.all(
        usernames.map((name) => attempt(world, name, "not the password")),
      );
      const statuses = burst.map((response) => response.status);
      assert.ok(statuses.includes(503));
      assert.ok(
        statuses.every((status) => status === 401 || status === 503),
        statuses.join(),
      );
      for (const [index, username] of usernames.entries()) {
        // Answered 401: one failure held, so four more are 401 and the next 429. Answered
        // 503: none held, so five are 401 and the next 429.
        const held = statuses[index] === 401 ? 1 : 0;
        await failTimes(world, username, 5 - held);
        assert.equal((await attempt(world, username, "not the password")).status, 429);
      }
    });
  });

  test("the window ends fifteen minutes after the first failure", async () => {
    await withWorld(async (world) => {
      await failTimes(world, PEOPLE.ana.username, 5);
      world.clock.advance(15 * MINUTE - 1000);
      const last = await attempt(world, PEOPLE.ana.username, PEOPLE.ana.password);
      assert.equal(last.status, 429);
      assert.equal(last.headers["retry-after"], "1");
      world.clock.advance(1000);
      assert.equal((await attempt(world, PEOPLE.ana.username, PEOPLE.ana.password)).status, 204);
    });
  });

  test("a username of 65 characters is refused and not counted; one of 64 is counted", async () => {
    await withWorld(async (world) => {
      const long = "a".repeat(65);
      for (let index = 0; index < 7; index += 1) {
        const response = await attempt(world, long, "not the password");
        assert.equal(response.status, 401);
        assert.equal(response.body, REFUSED);
      }
      const longest = "b".repeat(64);
      await failTimes(world, longest, 5);
      assert.equal((await attempt(world, longest, "not the password")).status, 429);
    });
  });

  test("a body that is not JSON is 415, one over 4096 bytes 413, and each closes the connection", async () => {
    await withWorld(async (world) => {
      const plain = await world.request("POST", "/api/login", {
        headers: { Origin: world.url, "Content-Type": "text/plain" },
        body: JSON.stringify(PEOPLE.ana),
      });
      assert.equal(plain.status, 415);
      assert.equal(plain.headers.connection, "close");
      const large = await world.request("POST", "/api/login", {
        headers: { Origin: world.url, "Content-Type": "application/json" },
        body: JSON.stringify({ ...PEOPLE.ana, password: "x".repeat(5000) }),
      });
      assert.equal(large.status, 413);
      assert.equal(large.headers.connection, "close");
      assert.ok(!world.output.some((line) => line.startsWith("login ")));
    });
  });

  test("GET /api/login is 405, and names the method it takes", async () => {
    await withWorld(async (world) => {
      const response = await world.request("GET", "/api/login");
      assert.equal(response.status, 405);
      assert.equal(response.headers.allow, "POST");
      assert.equal(response.body, JSON.stringify({ error: "method not allowed" }));
    });
  });
});
