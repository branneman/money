import assert from "node:assert/strict";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import type { Config } from "@money/shared";

import { booked, makeWorld, worldAspsps, worldConfig } from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";
import { completeRun, writePage } from "../inbox.ts";
import { writeState } from "../state.ts";

const A = "NL00BNKA0000000001";
const JOINT = "NL00BNKA0000000002";
const OLD = "NL00BNKA0000000003";
const B = "NL00BNKB0000000001";
const SAVINGS = "NL00BNKA0000000009";

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

// What a night that died leaves for an account: a completed run, whose success was never
// recorded, and after it an incomplete one. Each holds one transaction of its own.
const COMPLETED = "20260301T120000Z";
const INCOMPLETE = "20260301T130000Z";
const leaveRuns = async (world: World, account: string): Promise<void> => {
  const page = (id: string, date: string): string =>
    JSON.stringify({ transactions: [booked(id, date)] });
  await writePage(world.dataDir, account, COMPLETED, 1, page(`${account}-1`, "2026-02-25"));
  await completeRun(world.dataDir, account, COMPLETED, {
    started: "2026-03-01T12:00:00Z",
    window: { strategy: "default", dateFrom: "2026-01-30", dateTo: "2026-03-01" },
    pages: 1,
    attended: false,
  });
  await writePage(world.dataDir, account, INCOMPLETE, 1, page(`${account}-2`, "2026-02-26"));
};

// Both runs are merged after what the account already held, removed, and reported with the
// line a drain prints. No missing-record check is made, even for the completed run.
const assertSwept = async (world: World, account: string, held: string[] = []): Promise<void> => {
  assert.deepEqual(await idsOf(world, account), [...held, `${account}-1`, `${account}-2`]);
  assert.deepEqual(await world.inbox(account), []);
  for (const [run, complete] of [
    [COMPLETED, "yes"],
    [INCOMPLETE, "no"],
  ]) {
    assert.ok(
      world.lines.includes(
        `merged account=${account} run=${run} complete=${complete} pages=1 added=1 revised=0 unchanged=0 skipped=0 missing=0`,
      ),
    );
  }
};

// Every account closed, import-only or left unfetched: nothing is fetched through the API.
const nothingOpen = (): Config => ({
  ...worldConfig(),
  accounts: {
    "bnka-card": { bank: "bnka", import_id: "1001" },
    "bnka-old": { bank: "bnka", iban: OLD, closed: true },
    "bnka-savings": { bank: "bnka", iban: SAVINGS, fetch: false },
  },
});

test("a night with nothing new leaves every file byte for byte identical", async (t) => {
  const world = await authorised(t);
  const before = await world.files();
  assert.equal(await world.run("sync"), 0);
  assert.deepEqual(await world.files(), before);
  assert.match(printed(world), /done failed=0 newly_missing=0/);
  assert.equal(world.transactionRequests().length, 3);
});

// A night that can fetch nothing must not look like a night with nothing new.
test("sync fails, asking nothing, when no account is fetched through the API", async (t) => {
  const world = await makeWorld({ config: nothingOpen() });
  t.after(world.cleanup);
  assert.equal(await world.run("sync"), 1);
  assert.match(
    printed(world),
    /^no account is fetched through the API: each is closed, has no iban, or has fetch set to false$/m,
  );
  assert.equal(world.bank.requests.length, 0);
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

test("a backfill that died during auth is continued by sync, which asks for the longest period and fails the account", async (t) => {
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
  assert.match(
    printed(world),
    /^bnka-current: fetched without a first success, so the bank gave only what it serves unattended\. Run: auth bnka$/m,
  );
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

test("a closed account's waiting runs are merged and removed, and its state is left alone", async (t) => {
  // The first bank's one account, fetched while it was open, and closed with two runs left.
  const withOld = (closed: boolean): Config => ({
    ...worldConfig(),
    accounts: {
      "bnka-old": { bank: "bnka", iban: OLD, ...(closed ? { closed } : {}) },
      "bnkb-current": { bank: "bnkb", iban: B },
    },
  });
  const world = await makeWorld({ config: withOld(false) });
  t.after(world.cleanup);
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("auth", "bnkb"), 0);
  await leaveRuns(world, "bnka-old");
  await writeFile(world.env.CONFIG_PATH, JSON.stringify(withOld(true)));
  const state = await readFile(join(world.stateDir, "bnka.json"), "utf8");
  // The precondition: the account has state of its own that a recorded success would change.
  assert.ok((await world.state("bnka"))?.accounts["bnka-old"]);

  world.at("2026-03-02T03:00:00Z");
  assert.equal(await world.run("sync"), 0);
  await assertSwept(world, "bnka-old");
  assert.equal(await readFile(join(world.stateDir, "bnka.json"), "utf8"), state);
});

test("an open account with fetch false is not fetched, needs no consent, and what waits is merged", async (t) => {
  const world = await authorised(t);
  const config = worldConfig();
  config.accounts["bnka-savings"] = { bank: "bnka", iban: SAVINGS, fetch: false };
  await writeFile(world.env.CONFIG_PATH, JSON.stringify(config));
  await leaveRuns(world, "bnka-savings");
  assert.equal(await world.run("sync"), 0);
  await assertSwept(world, "bnka-savings");
  assert.ok(!printed(world).includes("bnka-savings: "));
  assert.equal(world.transactionRequests().length, 3);
  assert.match(printed(world), /done failed=0 newly_missing=0/);
});

test("what waits for a bank whose consent has expired is merged", async (t) => {
  const aspsps = worldAspsps();
  aspsps[1].maximumConsentValidity = 10 * 86_400;
  const world = await authorised(t, { aspsps });
  await leaveRuns(world, "bnkb-current");
  const state = await readFile(join(world.stateDir, "bnkb.json"), "utf8");

  world.at("2026-03-12T03:00:00Z");
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^bnkb: the consent has expired\. Run: auth bnkb$/m);
  assert.match(printed(world), /^failed: bnkb$/m);
  await assertSwept(world, "bnkb-current", ["b1"]);
  assert.equal(await readFile(join(world.stateDir, "bnkb.json"), "utf8"), state);
});

test("what waits for a bank whose stored state cannot be used is merged", async (t) => {
  const world = await authorised(t);
  await leaveRuns(world, "bnkb-current");
  await writeFile(join(world.stateDir, "bnkb.json"), "{ half a fi");

  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^bnkb: the stored state of bnkb is not what the sync wrote/m);
  assert.match(printed(world), /^failed: bnkb$/m);
  await assertSwept(world, "bnkb-current", ["b1"]);
  assert.equal(await readFile(join(world.stateDir, "bnkb.json"), "utf8"), "{ half a fi");
});

test("what waits for an account the consent does not cover is merged", async (t) => {
  const world = await authorised(t);
  const state = await world.state("bnka");
  assert.ok(state);
  const kept = Object.fromEntries(
    Object.entries(state.accounts).filter(([key]) => key !== "bnka-joint"),
  );
  await writeState(world.stateDir, "bnka", { ...state, accounts: kept });
  await leaveRuns(world, "bnka-joint");
  assert.equal(await world.run("sync"), 1);
  assert.match(
    printed(world),
    /^bnka-joint: the stored consent does not cover it\. Run: auth bnka$/m,
  );
  assert.match(printed(world), /^failed: bnka-joint$/m);
  await assertSwept(world, "bnka-joint");
  assert.equal((await world.state("bnka"))?.accounts["bnka-joint"], undefined);
});

test("an account that fails before the sweep and again in it is named once", async (t) => {
  const world = await authorised(t);
  const state = await world.state("bnka");
  assert.ok(state);
  const kept = Object.fromEntries(
    Object.entries(state.accounts).filter(([key]) => key !== "bnka-joint"),
  );
  await writeState(world.stateDir, "bnka", { ...state, accounts: kept });
  const run = join(world.dataDir, ".inbox", "bnka-joint", "20260228T030000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "2.json"), '{"transactions":[]}');

  assert.equal(await world.run("sync"), 1);
  // The precondition: it failed in both places.
  assert.match(printed(world), /^bnka-joint: the stored consent does not cover it\./m);
  assert.match(printed(world), /^bnka-joint: run 20260228T030000Z stays in /m);
  assert.match(printed(world), /^done failed=1 newly_missing=0$/m);
  assert.match(printed(world), /^failed: bnka-joint$/m);
});

test("a swept run that cannot be read stays, and fails only its account", async (t) => {
  const world = await authorised(t);
  // The card has no iban, so it is swept, and before the closed account, which comes after
  // it in the configuration.
  const run = join(world.dataDir, ".inbox", "bnka-card", "20260228T030000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "2.json"), '{"transactions":[]}');
  await leaveRuns(world, "bnka-old");
  world.add(A, booked("a2", "2026-03-01"));
  world.add(B, booked("b2", "2026-03-01"));

  assert.equal(await world.run("sync"), 1);
  const at = world.lines.indexOf("bnka-card: bnka-card, run 20260228T030000Z: page 1 is absent");
  assert.notEqual(at, -1);
  assert.equal(
    world.lines[at + 1],
    "bnka-card: run 20260228T030000Z stays in .inbox/bnka-card/20260228T030000Z and " +
      "stops this account until it can be read. Nothing has been removed.",
  );
  assert.match(printed(world), /^failed: bnka-card$/m);
  assert.deepEqual(await readdir(run), ["2.json"]);
  await assertSwept(world, "bnka-old");
  assert.deepEqual(await idsOf(world, "bnka-current"), ["a1", "a2"]);
  assert.deepEqual(await idsOf(world, "bnkb-current"), ["b1", "b2"]);
});

test("runs under a key the configuration does not name are kept and reported", async (t) => {
  const world = await authorised(t);
  await writePage(world.dataDir, "bnka-gone", COMPLETED, 1, '{"transactions":[]}');
  assert.equal(await world.run("sync"), 1);
  assert.ok(
    world.lines.includes(
      "bnka-gone: 1 run(s) wait in .inbox/bnka-gone for an account the configuration does not name. They are kept; nothing has been removed.",
    ),
  );
  assert.match(printed(world), /^failed: bnka-gone$/m);
  assert.equal((await world.inbox("bnka-gone")).length, 1);
});

test("an empty directory under an unknown key is not reported", async (t) => {
  const world = await authorised(t);
  await mkdir(join(world.dataDir, ".inbox", "bnka-gone"));
  assert.equal(await world.run("sync"), 0);
  assert.ok(!printed(world).includes("bnka-gone"));
});

test("an entry of .inbox that is not an account key is reported without its name", async (t) => {
  const world = await authorised(t);
  const inbox = join(world.dataDir, ".inbox");
  await writeFile(join(inbox, "notes.txt"), "x");
  await mkdir(join(inbox, "Bad_Name"));
  await writeFile(join(inbox, "Bad_Name", "1.json"), "{}");

  assert.equal(await world.run("sync"), 1);
  const line =
    ".inbox holds an entry that is not an account key. It is kept; nothing has been removed.";
  assert.equal(world.lines.filter((each) => each === line).length, 2);
  assert.match(printed(world), /^failed: \.inbox$/m);
  for (const name of ["notes", "bad_name"]) {
    assert.ok(!printed(world).toLowerCase().includes(name));
  }
  const left = await readdir(inbox);
  assert.ok(left.includes("notes.txt") && left.includes("Bad_Name"));
});

test("with every account closed, sync still merges what waits, then stops as before", async (t) => {
  const world = await makeWorld({ config: nothingOpen() });
  t.after(world.cleanup);
  await leaveRuns(world, "bnka-old");
  assert.equal(await world.run("sync"), 1);
  await assertSwept(world, "bnka-old");
  assert.equal(
    world.lines.at(-1),
    "no account is fetched through the API: each is closed, has no iban, or has fetch set to false",
  );
  assert.equal(world.bank.requests.length, 0);
});

test("with every account closed, what the sweep cannot merge is still named as failed", async (t) => {
  const world = await makeWorld({ config: nothingOpen() });
  t.after(world.cleanup);
  await writePage(world.dataDir, "bnka-gone", COMPLETED, 1, '{"transactions":[]}');
  assert.equal(await world.run("sync"), 1);
  assert.deepEqual(world.lines, [
    "bnka-gone: 1 run(s) wait in .inbox/bnka-gone for an account the configuration does not name. They are kept; nothing has been removed.",
    "no account is fetched through the API: each is closed, has no iban, or has fetch set to false",
    "failed: bnka-gone",
  ]);
});

test("an account with nothing waiting is not read", async (t) => {
  const world = await authorised(t);
  await mkdir(join(world.dataDir, "bnka-old", "api"), { recursive: true });
  await writeFile(join(world.dataDir, "bnka-old", "api", "2026.json"), "{ half a fi");
  await mkdir(join(world.dataDir, ".inbox", "bnka-old"));
  // The precondition: reading the account would fail it.
  await assert.rejects(world.records("bnka-old"));
  assert.equal(await world.run("sync"), 0);
  assert.ok(!printed(world).includes("bnka-old"));
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
