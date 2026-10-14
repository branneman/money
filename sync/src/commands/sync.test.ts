import assert from "node:assert/strict";
import { chmod, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { booked, makeWorld, worldAspsps } from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";
import { writeState } from "../state.ts";

const A = "NL00BNKA0000000001";
const JOINT = "NL00BNKA0000000002";
const B = "NL00BNKB0000000001";

// Both banks authorised on the first of March, each with one transaction, and the second
// of March about to begin.
const authorised = async (
  t: TestContext,
  options: Parameters<typeof makeWorld>[0] = {},
): Promise<World> => {
  const world = await makeWorld(options);
  t.after(world.cleanup);
  world.add(A, booked("a1", "2026-02-20"));
  world.add(B, booked("b1", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("auth", "bnkb"), 0);
  world.bank.requests.length = 0;
  world.lines.length = 0;
  world.at("2026-03-02T03:00:00Z");
  return world;
};
const printed = (world: World): string => world.lines.join("\n");
const idsOf = async (world: World, account: string): Promise<string[]> =>
  (await world.records(account)).map((record) => record.id);

test("a night with nothing new leaves every file byte for byte identical", async (t) => {
  const world = await authorised(t);
  const before = await world.files();
  assert.equal(await world.run("sync"), 0);
  assert.deepEqual(await world.files(), before);
  assert.match(printed(world), /done failed=0 newly_missing=0/);
  assert.equal(world.transactionRequests().length, 3);
});

test("new transactions at every bank are stored", async (t) => {
  const world = await authorised(t);
  world.add(A, booked("a2", "2026-03-01"));
  world.add(JOINT, booked("j1", "2026-03-01"));
  world.add(B, booked("b2", "2026-03-01"));
  assert.equal(await world.run("sync"), 0);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
  assert.deepEqual(await idsOf(world, "bnka-joint"), ["j1"]);
  assert.deepEqual(await idsOf(world, "bnkb-current"), ["b1", "b2"]);
  assert.equal(
    (await world.state("bnkb"))?.accounts["bnkb-current"].last_success,
    "2026-03-02T03:00:00Z",
  );
});

test("the success recorded is the moment the fetch began, however long it took", async (t) => {
  const world = await authorised(t);
  world.add(A, booked("a2", "2026-03-01"));
  // Half an hour passes while the bank answers the first transactions request.
  const real = world.deps.fetch;
  let moved = false;
  world.deps.fetch = async (url, init) => {
    const answer = await real(url, init);
    if (!moved && url.includes("/transactions")) {
      moved = true;
      world.at("2026-03-02T03:30:00Z");
    }
    return answer;
  };
  assert.equal(await world.run("sync"), 0);
  assert.ok(moved);
  // The first account began before the clock moved, the second after it.
  const state = await world.state("bnka");
  assert.equal(state?.accounts["bnka-current"].last_success, "2026-03-02T03:00:00Z");
  assert.equal(state?.accounts["bnka-joint"].last_success, "2026-03-02T03:30:00Z");
  // What the first fetch stored was first seen when it was merged, after the answer.
  assert.equal((await world.records("bnka-current"))[1].first_seen, "2026-03-02T03:30:00Z");
});

test("a bank that was never authorised fails, and the others are synced", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  assert.equal(await world.run("auth", "bnka"), 0);
  world.at("2026-03-02T03:00:00Z");
  world.add(A, booked("a2", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnkb: no consent is stored\. Run: auth bnkb/);
  assert.match(printed(world), /failed: bnkb/);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a2"]);
});

test("an expired consent makes no request, says to run auth, and does not stop the other bank", async (t) => {
  const aspsps = worldAspsps();
  aspsps[1].maximumConsentValidity = 10 * 86_400;
  const world = await authorised(t, { aspsps });
  const uid = (await world.state("bnkb"))?.accounts["bnkb-current"].uid ?? "";
  const before = await world.files();

  world.at("2026-03-12T03:00:00Z");
  world.add(A, booked("a2", "2026-03-11"));
  world.add(B, booked("b2", "2026-03-11"));
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnkb: the consent has expired\. Run: auth bnkb/);
  assert.ok(world.transactionRequests().every((request) => !request.path.includes(uid)));
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
  assert.equal(
    (await world.files()).get(join("bnkb-current", "api", "2026.json")),
    before.get(join("bnkb-current", "api", "2026.json")),
  );
});

test("a consent revoked at the bank fails that bank and says to run auth", async (t) => {
  const world = await authorised(t);
  world.bank.revoke("Other Example Bank");
  world.add(A, booked("a2", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnkb-current: Enable Banking answered 401 REVOKED_SESSION/);
  assert.match(printed(world), /bnkb: the consent is gone\. Run: auth bnkb/);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
});

test("a transaction that disappears from its window is kept, and fails the run once", async (t) => {
  const world = await authorised(t);
  const versions = world.add(A, booked("gone", "2026-03-01"));
  assert.equal(await world.run("sync"), 0);

  world.at("2026-03-03T03:00:00Z");
  versions.push({ from: "2026-03-02T12:00:00Z", raw: null });
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnka-current: 1 stored record\(s\) were absent/);
  assert.match(printed(world), /done failed=0 newly_missing=1/);

  world.at("2026-03-04T03:00:00Z");
  assert.equal(await world.run("sync"), 0);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "gone"]);
});

test("accounts fail separately: one account's error leaves the rest synced", async (t) => {
  const world = await authorised(t);
  world.add(JOINT, booked("j1", "2026-03-01"));
  world.add(B, booked("b2", "2026-03-01"));
  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /failed: bnka-current$/m);
  assert.deepEqual(await idsOf(world, "bnka-joint"), ["j1"]);
  assert.deepEqual(await idsOf(world, "bnkb-current"), ["b1", "b2"]);
  const state = await world.state("bnka");
  assert.equal(state?.accounts["bnka-current"].last_success, "2026-03-01T03:00:00Z");
  assert.equal(state?.accounts["bnka-joint"].last_success, "2026-03-02T03:00:00Z");
});

test("a backfill that died during auth is continued by sync, asking for the longest period again", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  for (const id of ["a", "b", "c"]) world.add(A, booked(id, "2026-02-20"));
  assert.equal(await world.run("auth", "bnkb"), 0);
  world.bank.pageSize = 2;
  world.bank.failRequest(5, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.deepEqual(await idsOf(world, "bnka-current"), []);

  world.at("2026-03-02T03:00:00Z");
  world.bank.requests.length = 0;
  // Without the user present the longest period is stored but is not a first success, so
  // the account still fails.
  assert.equal(await world.run("sync"), 1);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a", "b", "c"]);
  assert.equal(world.transactionRequests()[0].query.strategy, "longest");
});

test("an account the stored consent does not cover fails, and says to run auth", async (t) => {
  const world = await authorised(t);
  const state = await world.state("bnka");
  assert.ok(state);
  const kept = Object.fromEntries(
    Object.entries(state.accounts).filter(([key]) => key !== "bnka-joint"),
  );
  await writeState(world.stateDir, "bnka", { ...state, accounts: kept });
  world.add(A, booked("a2", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnka-joint: the stored consent does not cover it\. Run: auth bnka/);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
});

test("stored state the sync did not write fails its bank only", async (t) => {
  const world = await authorised(t);
  await writeFile(join(world.stateDir, "bnkb.json"), "{ half a fi");
  world.add(A, booked("a2", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /bnkb: the stored state of bnkb is not what the sync wrote/);
  assert.match(printed(world), /failed: bnkb$/m);
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
});

test("a consent close to its end is logged by sync, which still succeeds", async (t) => {
  const world = await authorised(t, { env: { CONSENT_WARN_DAYS: "200" } });
  assert.equal(await world.run("sync"), 0);
  assert.match(printed(world), /consent-expiring bank=bnka days=179/);
  assert.match(printed(world), /consent-expiring bank=bnkb days=179/);
});

test("no PSU header is sent by any command", async (t) => {
  const world = await authorised(t);
  world.bank.requests.length = 0;
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("sync"), 0);
  assert.ok(world.bank.requests.length >= 8);
  const names = world.bank.requests.flatMap((request) => Object.keys(request.headers));
  assert.deepEqual(
    names.filter((name) => name.startsWith("psu-")),
    [],
  );
});

test("a lock held by a live run stops sync; one left by a dead run does not", async (t) => {
  const world = await authorised(t);
  await writeFile(join(world.stateDir, "lock"), "999\n");
  world.alive.add(999);
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /another run holds the lock in STATE_DIR/);
  assert.equal(world.bank.requests.length, 0);

  world.alive.clear();
  assert.equal(await world.run("sync"), 0);
  assert.ok(!(await readdir(world.stateDir)).includes("lock"));
});

test("an error nobody expected stops the whole run and prints only its class and code", async (t) => {
  const world = await authorised(t);
  await rm(join(world.dataDir, ".inbox", "bnka-current"), { recursive: true });
  await writeFile(join(world.dataDir, ".inbox", "bnka-current"), "Recognisable contents");
  assert.equal(await world.run("sync"), 1);
  assert.equal(world.lines[world.lines.length - 1], "unexpected Error ENOTDIR");
  assert.ok(!(await readdir(world.stateDir)).includes("lock"));
});

test("a data directory that cannot be written stops the run before any request", async (t) => {
  const world = await makeWorld();
  t.after(async () => {
    await chmod(world.dataDir, 0o755);
    await world.cleanup();
  });
  await world.openSession("bnka");
  await world.openSession("bnkb");
  world.bank.requests.length = 0;
  await chmod(world.dataDir, 0o555);
  // The precondition: this user is in fact refused. Without it the test proves nothing.
  await assert.rejects(writeFile(join(world.dataDir, "probe"), ""), { code: "EACCES" });

  assert.equal(await world.run("sync"), 1);
  assert.equal(printed(world), "DATA_DIR cannot be written (EACCES)");
  assert.equal(world.bank.requests.length, 0);
  assert.deepEqual(await readdir(world.stateDir), ["bnka.json", "bnkb.json"]);
});
