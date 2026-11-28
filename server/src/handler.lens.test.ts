import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { makeServerWorld, PEOPLE, worldConfig } from "../testing/world.ts";
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

const get = (world: ServerWorld, cookie: string, path: string) =>
  world.request("GET", path, { headers: { Cookie: cookie } });

type Listed = { key: string; bank: string; transactions: number };

const accountsOf = async (world: ServerWorld, cookie: string): Promise<Listed[]> => {
  const response = await get(world, cookie, "/api/accounts");
  assert.equal(response.status, 200);
  return (JSON.parse(response.body) as { accounts: Listed[] }).accounts;
};

const keysOf = (list: Listed[]): string[] => list.map((account) => account.key);

describe("lenses", { concurrency: true }, () => {
  test("ana sees both accounts and ben only the shared one, in the session and the list", async () => {
    await withWorld(async (world) => {
      const ana = await loggedIn(world, "ana");
      const ben = await loggedIn(world, "ben");
      assert.deepEqual((await world.session(ana)).accounts, ["bnka-shared", "bnka-solo"]);
      assert.deepEqual((await world.session(ben)).accounts, ["bnka-shared"]);
      assert.deepEqual(keysOf(await accountsOf(world, ana)), ["bnka-shared", "bnka-solo"]);
      assert.deepEqual(keysOf(await accountsOf(world, ben)), ["bnka-shared"]);
    });
  });

  test("the transaction counts are for the person's accounts only", async () => {
    await withWorld(async (world) => {
      const counts = (list: Listed[]) =>
        Object.fromEntries(list.map((account) => [account.key, account.transactions]));
      assert.deepEqual(counts(await accountsOf(world, await loggedIn(world, "ana"))), {
        "bnka-solo": 3,
        "bnka-shared": 2,
      });
      assert.deepEqual(counts(await accountsOf(world, await loggedIn(world, "ben"))), {
        "bnka-shared": 2,
      });
    });
  });

  test("another's account and one that does not exist get the same answer", async () => {
    await withWorld(async (world) => {
      const ben = await loggedIn(world, "ben");
      const theirs = await get(world, ben, "/api/accounts/bnka-solo");
      const nothing = await get(world, ben, "/api/accounts/bnka-nope");
      assert.equal(theirs.status, 404);
      assert.equal(theirs.status, nothing.status);
      assert.equal(theirs.body, nothing.body);
      const own = await get(world, ben, "/api/accounts/bnka-shared");
      assert.equal(own.status, 200);
      assert.equal((JSON.parse(own.body) as Listed).transactions, 2);
    });
  });

  test("a person taken off an account loses it on the next request, without a new login", async () => {
    await withWorld(async (world) => {
      const ben = await loggedIn(world, "ben");
      assert.equal((await accountsOf(world, ben)).length, 1);
      const config = structuredClone(await worldConfig());
      config.accounts["bnka-shared"].owners = ["ana"];
      await world.writeConfig(config);
      assert.deepEqual(await accountsOf(world, ben), []);
      assert.deepEqual((await world.session(ben)).accounts, []);
      assert.equal((await get(world, ben, "/api/accounts/bnka-shared")).status, 404);
    });
  });
});
