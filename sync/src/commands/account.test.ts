import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { booked, Crash, makeWorld } from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";
import type { Checkpoint } from "../context.ts";
import { fetchable, fetchAccounts } from "./account.ts";

const IBAN = "NL00BNKA0000000001";
const ACCOUNT = "bnka-current";

// A world with a consent at the first bank, and nothing fetched yet.
const start = async (
  t: TestContext,
  at?: string,
): Promise<{ world: World; uids: Record<string, string> }> => {
  const world = await makeWorld({ start: at });
  t.after(world.cleanup);
  const uids = await world.openSession("bnka");
  world.bank.requests.length = 0;
  return { world, uids };
};

const fetchOne = (world: World, uids: Record<string, string>) =>
  fetchAccounts(world.context(), "bnka", [[ACCOUNT, uids[ACCOUNT]]]);

const idsOf = async (world: World): Promise<string[]> =>
  (await world.records(ACCOUNT)).map((record) => record.id);

const lastSuccess = async (world: World): Promise<string | undefined> =>
  (await world.state("bnka"))?.accounts[ACCOUNT].last_success;

test("the accounts to fetch are the open ones with an IBAN, by bank", async (t) => {
  const { world } = await start(t);
  assert.deepEqual(
    [...fetchable(world.config)],
    [
      ["bnka", ["bnka-current", "bnka-joint"]],
      ["bnkb", ["bnkb-current"]],
    ],
  );
  const cards = { ...world.config, accounts: { "bnka-card": { bank: "bnka", import_id: "1001" } } };
  assert.deepEqual([...fetchable(cards)], []);
});

test("a first fetch asks for the longest period, stores everything and records its start", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("old", "2024-06-01"));
  world.add(IBAN, booked("new", "2026-02-20"));

  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["old", "new"]);
  assert.deepEqual(world.transactionRequests()[0].query, {
    transaction_status: "BOOK",
    strategy: "longest",
  });
  assert.equal(await lastSuccess(world), "2026-03-01T03:00:00Z");
  assert.deepEqual(await world.inbox(ACCOUNT), []);
  assert.equal((await world.records(ACCOUNT))[0].first_seen, "2026-03-01T03:00:00Z");
});

test("an account with no transactions completes, and creates nothing in the archive", async (t) => {
  const { world, uids } = await start(t);
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.equal(await lastSuccess(world), "2026-03-01T03:00:00Z");
  assert.deepEqual(
    (await readdir(world.dataDir)).filter((name) => name !== ".inbox"),
    [],
  );
});

test("a later night asks for a window anchored on the last success", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  await fetchOne(world, uids);

  world.at("2026-03-11T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-10"));
  world.bank.requests.length = 0;
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(world.transactionRequests()[0].query, {
    transaction_status: "BOOK",
    date_from: "2026-01-30",
    date_to: "2026-03-11",
  });
  assert.deepEqual(await idsOf(world), ["a", "b"]);
  assert.equal(await lastSuccess(world), "2026-03-11T03:00:00Z");
});

test("pages are followed to the end", async (t) => {
  const { world, uids } = await start(t);
  for (const id of ["a", "b", "c", "d", "e"]) world.add(IBAN, booked(id, "2026-02-20"));
  world.bank.pageSize = 2;
  await fetchOne(world, uids);
  assert.equal(world.transactionRequests().length, 3);
  assert.deepEqual(await idsOf(world), ["a", "b", "c", "d", "e"]);
  assert.match(
    world.lines.join("\n"),
    /merged account=bnka-current .*complete=yes pages=3 added=5/,
  );
});

test("a page that fails halfway writes nothing, and what arrived is merged by the next run", async (t) => {
  const { world, uids } = await start(t);
  for (const id of ["a", "b", "c"]) world.add(IBAN, booked(id, "2026-02-20"));
  world.bank.pageSize = 2;
  world.bank.failRequest(2, { status: 500, error: "ASPSP_ERROR" });

  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), []);
  assert.equal(await lastSuccess(world), undefined);
  const [left] = await world.inbox(ACCOUNT);
  assert.equal(left.marker, null);
  assert.equal(left.pages.length, 1);
  assert.match(world.lines.join("\n"), /bnka-current: Enable Banking answered 500 ASPSP_ERROR/);

  world.at("2026-03-02T03:00:00Z");
  world.bank.requests.length = 0;
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["a", "b", "c"]);
  assert.match(
    world.lines.join("\n"),
    /merged account=bnka-current run=20260301T030000Z complete=no pages=1 added=2/,
  );
  // No success was recorded for the half that arrived, so the longest period is asked again.
  assert.equal(world.transactionRequests()[0].query.strategy, "longest");
  assert.deepEqual(await world.inbox(ACCOUNT), []);
});

test("a bank that repeats a continuation key stops the account instead of looping", async (t) => {
  const { world, uids } = await start(t);
  world.bank.failRequest(1, { body: '{"transactions":[],"continuation_key":"again"}' });
  world.bank.failRequest(2, { body: '{"transactions":[],"continuation_key":"again"}' });
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.equal(world.transactionRequests().length, 2);
  assert.match(world.lines.join("\n"), /bnka-current, page 2 repeats an earlier continuation_key/);
});

test("an answer that is not JSON is not a page, and is not kept", async (t) => {
  const { world, uids } = await start(t);
  world.bank.failRequest(1, { body: "<html>Recognisable gateway page</html>" });
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.deepEqual(await world.inbox(ACCOUNT), []);
  assert.match(world.lines.join("\n"), /bnka-current, page 1 is not valid JSON/);
  assert.ok(!world.lines.join("\n").includes("Recognisable"));
});

test("a page the code cannot read is kept, and stops its account until it is dealt with", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  world.add(IBAN, booked("", "2026-02-21"));

  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.match(
    world.lines.join("\n"),
    /page 1, transaction 2 is booked without an entry_reference/,
  );
  assert.equal((await world.inbox(ACCOUNT)).length, 1);
  assert.deepEqual(await idsOf(world), []);
  // What blocks the account, where it is, and that it is still there.
  const way =
    "bnka-current: run 20260301T030000Z stays in .inbox/bnka-current/20260301T030000Z and " +
    "stops this account until it can be read. Nothing has been removed.";
  assert.deepEqual(world.lines.slice(-2), [
    "bnka-current: bnka-current, run 20260301T030000Z, page 1, transaction 2 is booked without an entry_reference",
    way,
  ]);

  // The next night does not ask the bank: fetching past the run could put revisions in
  // the wrong order, and removing it would discard something a bank sent.
  world.at("2026-03-02T03:00:00Z");
  world.bank.requests.length = 0;
  world.lines.length = 0;
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.equal(world.transactionRequests().length, 0);
  assert.equal((await world.inbox(ACCOUNT)).length, 1);
  assert.equal(world.lines.at(-1), way);
});

test("a run whose marker or pages are not what the sync wrote names the same way out", async (t) => {
  const { world, uids } = await start(t);
  const run = join(world.dataDir, ".inbox", ACCOUNT, "20260228T030000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "2.json"), '{"transactions":[]}');
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.deepEqual(world.lines, [
    "bnka-current: bnka-current, run 20260228T030000Z: page 1 is absent",
    "bnka-current: run 20260228T030000Z stays in .inbox/bnka-current/20260228T030000Z and " +
      "stops this account until it can be read. Nothing has been removed.",
  ]);
  assert.equal(world.transactionRequests().length, 0);
});

test("a failure that is not a run's names no run", async (t) => {
  const { world, uids } = await start(t);
  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.ok(!world.lines.join("\n").includes("stays in"));
});

test("one transaction twice on a page with different contents stops the account, unnamed", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("twice", "2026-02-20", { note: "first" }));
  world.add(IBAN, booked("twice", "2026-02-20", { note: "second" }));
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.equal(
    world.lines.at(-2),
    "bnka-current: bnka-current, run 20260301T030000Z, page 1 holds the same transaction twice with different contents",
  );
  assert.match(world.lines.at(-1) ?? "", /^bnka-current: run 20260301T030000Z stays in /);
  assert.ok(!world.lines.join("\n").includes("twice/"));
  assert.ok(!world.lines.join("\n").includes("/twice"));
  assert.equal((await world.inbox(ACCOUNT)).length, 1);
  assert.deepEqual(await idsOf(world), []);
});

test("a newly missing record is reported even when the run dies right after recording it", async (t) => {
  const { world, uids } = await start(t);
  const versions = world.add(IBAN, booked("gone", "2026-02-20"));
  await fetchOne(world, uids);

  world.at("2026-03-02T03:00:00Z");
  versions.push({ from: "2026-03-01T12:00:00Z", raw: null });
  world.crashAt = "state-written";
  await assert.rejects(fetchOne(world, uids), Crash);
  // The state already remembers the record as missing, so no later run finds it newly so.
  assert.deepEqual((await world.state("bnka"))?.accounts[ACCOUNT].missing, ["gone"]);

  world.at("2026-03-03T03:00:00Z");
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  const alerts = world.lines.filter((line) => line.includes("were absent from a fetch"));
  assert.equal(alerts.length, 1);
});

test("a transaction that is not booked is skipped and counted", async (t) => {
  const { world, uids } = await start(t);
  world.aspsps[0].ignoresStatusFilter = true;
  world.add(IBAN, booked("a", "2026-02-20"));
  world.add(IBAN, { status: "PDNG", transaction_amount: { currency: "EUR", amount: "1.00" } });
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["a"]);
  assert.match(world.lines.join("\n"), /added=1 revised=0 unchanged=0 skipped=1/);
});

test("a transaction that changed at the bank keeps its earlier version", async (t) => {
  const { world, uids } = await start(t);
  const versions = world.add(IBAN, booked("a", "2026-02-20", { note: "first" }));
  await fetchOne(world, uids);

  world.at("2026-03-02T03:00:00Z");
  versions.push({
    from: "2026-03-01T12:00:00Z",
    raw: booked("a", "2026-02-20", { note: "second" }),
  });
  await fetchOne(world, uids);
  const [record] = await world.records(ACCOUNT);
  assert.equal(record.raw.note, "second");
  assert.deepEqual(record.revisions, [
    { replaced_at: "2026-03-02T03:00:00Z", raw: booked("a", "2026-02-20", { note: "first" }) },
  ]);
});

test("the same transaction on two pages with different contents becomes a revision", async (t) => {
  const { world, uids } = await start(t);
  const first = JSON.stringify({
    transactions: [booked("a", "2026-02-20", { note: "first" })],
    continuation_key: "next",
  });
  const second = JSON.stringify({ transactions: [booked("a", "2026-02-20", { note: "second" })] });
  world.bank.failRequest(1, { body: first });
  world.bank.failRequest(2, { body: second });
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  const [record] = await world.records(ACCOUNT);
  assert.equal(record.raw.note, "second");
  assert.equal(record.revisions.length, 1);
});

test("a stored record absent from a window that should hold it is kept, and reported once", async (t) => {
  const { world, uids } = await start(t);
  const versions = world.add(IBAN, booked("gone", "2026-02-20"));
  world.add(IBAN, booked("stays", "2026-02-21"));
  await fetchOne(world, uids);

  world.at("2026-03-02T03:00:00Z");
  versions.push({ from: "2026-03-01T12:00:00Z", raw: null });
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 1 });
  assert.deepEqual(await idsOf(world), ["gone", "stays"]);
  assert.deepEqual((await world.state("bnka"))?.accounts[ACCOUNT].missing, ["gone"]);
  assert.match(
    world.lines.join("\n"),
    /bnka-current: 1 stored record\(s\) were absent from a fetch that should hold them\. They are kept\./,
  );

  world.at("2026-03-03T03:00:00Z");
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["gone", "stays"]);

  // Once the record's date has left the window it is no longer looked for.
  world.at("2026-05-01T03:00:00Z");
  await fetchOne(world, uids);
  world.at("2026-05-02T03:00:00Z");
  await fetchOne(world, uids);
  assert.deepEqual((await world.state("bnka"))?.accounts[ACCOUNT].missing, []);
});

test("a backfill makes no missing-record check", async (t) => {
  const { world, uids } = await start(t);
  const versions = world.add(IBAN, booked("gone", "2026-02-20"));
  world.bank.pageSize = 1;
  world.add(IBAN, booked("z", "2026-02-21"));
  world.bank.failRequest(2, { status: 500, error: "ASPSP_ERROR" });
  await fetchOne(world, uids);

  world.at("2026-03-02T03:00:00Z");
  versions.push({ from: "2026-03-01T12:00:00Z", raw: null });
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["gone", "z"]);
});

const points: Checkpoint[] = ["page-written", "received", "data-written", "state-written"];
for (const point of points) {
  test(`a run that dies at ${point} is finished by the next one, and nothing is lost or doubled`, async (t) => {
    const { world, uids } = await start(t);
    world.add(IBAN, booked("a", "2026-02-20"));
    await fetchOne(world, uids);

    world.at("2026-03-02T03:00:00Z");
    world.add(IBAN, booked("b", "2026-03-01"));
    world.crashAt = point;
    await assert.rejects(fetchOne(world, uids), Crash);

    world.at("2026-03-03T03:00:00Z");
    world.bank.requests.length = 0;
    assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
    assert.deepEqual(await idsOf(world), ["a", "b"]);
    assert.deepEqual(await world.inbox(ACCOUNT), []);
    assert.equal(await lastSuccess(world), "2026-03-03T03:00:00Z");
    // One new fetch, of one page. What the dead run received is not asked for again.
    assert.equal(world.transactionRequests().length, 1);
    // The record is first seen by whichever run wrote it: the dead one, if it got that far.
    const written = point === "data-written" || point === "state-written";
    const b = (await world.records(ACCOUNT))[1];
    assert.equal(b.first_seen, written ? "2026-03-02T03:00:00Z" : "2026-03-03T03:00:00Z");
    assert.equal(b.revisions.length, 0);
  });
}

test("a run that received everything and died records its own start, without asking again", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  world.crashAt = "received";
  await assert.rejects(fetchOne(world, uids), Crash);
  assert.notEqual((await world.inbox(ACCOUNT))[0].marker, null);

  // The bank is unreachable the next night. What was received is merged all the same.
  world.at("2026-03-02T03:00:00Z");
  world.bank.failRequest(1, { network: true });
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.deepEqual(await idsOf(world), ["a"]);
  assert.equal(await lastSuccess(world), "2026-03-01T03:00:00Z");
});

test("state is written after the data it describes", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  world.crashAt = "data-written";
  await assert.rejects(fetchOne(world, uids), Crash);
  assert.deepEqual(await idsOf(world), ["a"]);
  assert.equal(await lastSuccess(world), undefined);
});

test("a record left in two year files by an interrupted write is recovered first", async (t) => {
  const { world, uids } = await start(t, "2026-01-05T03:00:00Z");
  const versions = world.add(IBAN, booked("a", "2025-12-31"));
  await fetchOne(world, uids);
  const old = join(ACCOUNT, "api", "2025.json");
  const before = (await world.files()).get(old) ?? "";

  // The bank moves the booking into the next year. The run writes the new year file and
  // removes the old one; putting the old one back is what dying between the two leaves.
  world.at("2026-01-06T03:00:00Z");
  versions.push({ from: "2026-01-05T12:00:00Z", raw: booked("a", "2026-01-02") });
  await fetchOne(world, uids);
  assert.deepEqual([...(await world.files()).keys()], [join(ACCOUNT, "api", "2026.json")]);
  await writeFile(join(world.dataDir, old), before);
  await assert.rejects(world.records(ACCOUNT), /stored in more than one year file/);

  world.at("2026-01-07T03:00:00Z");
  assert.deepEqual(await fetchOne(world, uids), { failed: [], newlyMissing: 0 });
  const [record] = await world.records(ACCOUNT);
  assert.equal(record.date, "2026-01-02");
  assert.equal(record.revisions.length, 1);
  assert.match(world.lines.join("\n"), /recovered account=bnka-current records=1/);
});

test("one account's failure does not stop the next, unless the consent is gone", async (t) => {
  const { world, uids } = await start(t);
  world.add("NL00BNKA0000000002", booked("j", "2026-02-20"));
  const both = [
    [ACCOUNT, uids[ACCOUNT]],
    ["bnka-joint", uids["bnka-joint"]],
  ] as const;

  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.deepEqual(await fetchAccounts(world.context(), "bnka", both), {
    failed: [ACCOUNT],
    newlyMissing: 0,
  });
  assert.equal((await world.records("bnka-joint")).length, 1);

  world.at("2026-03-02T03:00:00Z");
  world.bank.revoke("Example Bank");
  world.bank.requests.length = 0;
  assert.deepEqual(await fetchAccounts(world.context(), "bnka", both), {
    failed: [ACCOUNT, "bnka-joint"],
    newlyMissing: 0,
  });
  assert.equal(world.transactionRequests().length, 1);
  assert.match(world.lines.join("\n"), /bnka: the consent is gone\. Run: auth bnka/);
});

test("a window the bank no longer serves unattended says to run auth", async (t) => {
  const { world, uids } = await start(t);
  await fetchOne(world, uids);
  // 136 days on: the consent still holds, and the window starts before the 90 days the
  // fake bank serves without the user.
  world.at("2026-07-15T03:00:00Z");
  assert.deepEqual(await fetchOne(world, uids), { failed: [ACCOUNT], newlyMissing: 0 });
  assert.match(
    world.lines.join("\n"),
    /bnka-current: the bank does not serve that period unattended\. Run: auth bnka/,
  );
});

test("an account named for a backfill is asked for the longest period despite its success", async (t) => {
  const { world, uids } = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  world.add("NL00BNKA0000000002", booked("j", "2026-02-20"));
  const both = [
    [ACCOUNT, uids[ACCOUNT]],
    ["bnka-joint", uids["bnka-joint"]],
  ] as const;
  await fetchAccounts(world.context(), "bnka", both);

  world.at("2026-03-02T03:00:00Z");
  world.bank.requests.length = 0;
  assert.deepEqual(await fetchAccounts(world.context(), "bnka", both, new Set([ACCOUNT])), {
    failed: [],
    newlyMissing: 0,
  });
  const [first, second] = world.transactionRequests();
  assert.deepEqual(first.query, { transaction_status: "BOOK", strategy: "longest" });
  assert.deepEqual(second.query, {
    transaction_status: "BOOK",
    date_from: "2026-01-30",
    date_to: "2026-03-02",
  });
  assert.equal(await lastSuccess(world), "2026-03-02T03:00:00Z");
});
