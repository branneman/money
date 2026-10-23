// The two claims the project rests on, over the real commands: however the nights fall,
// wherever a run dies, and whenever the account is closed for a while, the archive ends up
// showing what the bank holds, and every version the bank ever returned is in it. The first
// and the final `auth` are never disturbed: a backfill that dies part-way is covered by the
// named scenarios in commands/.
import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
// The oracle compares with Node's own equality, so it shares no helper with the merge it
// judges.
import { isDeepStrictEqual } from "node:util";

import { view } from "@money/shared";
import type { ArchiveRecord, Config } from "@money/shared";
import { makeRandom } from "@money/shared/testing";
import type { Random } from "@money/shared/testing";

import type { FakeAspsp, FakeBank, FakeVersion } from "../testing/fake-bank.ts";
import { booked, CRASHED, makeWorld } from "../testing/world.ts";
import type { World } from "../testing/world.ts";
import { NOTHING_FETCHED } from "./commands/account.ts";
import type { Checkpoint } from "./context.ts";
import { addDays, dateOf, timestampOf } from "./time.ts";

const SEEDS = 9;
const NIGHTS = 20;
const DAY = 86_400_000;
// Late December, so that the nights cross a year boundary.
const START = Date.parse("2025-12-22T03:00:00Z");
const IBAN = "NL00BNKA0000000001";
const ACCOUNT = "bnka-current";
// Where a run dies. The two deaths that leave a run in the inbox with something the
// archive lacks come up most: an incomplete run at `page-written`, a completed one at
// `received`. At the other two the run is still in the inbox, but holds nothing that is
// not already in the archive.
const POINTS: Checkpoint[] = [
  "page-written",
  "page-written",
  "page-written",
  "page-written",
  "received",
  "received",
  "received",
  "data-written",
  "data-written",
  "state-written",
  "state-written",
];

type Raw = Record<string, unknown>;

// Closed in the configuration, the account is never fetched, and only the sweep merges what
// waits for it.
const configWith = (closed: boolean): Config => ({
  banks: { bnka: { aspsp: { name: "Example Bank", country: "NL" } } },
  accounts: { [ACCOUNT]: { bank: "bnka", iban: IBAN, ...(closed ? { closed } : {}) } },
  imports: {},
});
const config = configWith(false);

const setClosed = (world: World, closed: boolean): Promise<void> =>
  writeFile(world.env.CONFIG_PATH, JSON.stringify(configWith(closed)));

// The run of a night starts at three; `minutes` moves away from that.
const stamp = (night: number, minutes = 0): string =>
  timestampOf(new Date(START + night * DAY + minutes * 60_000));

const bankWith = (transactions: FakeVersion[][]): FakeAspsp => ({
  name: "Example Bank",
  country: "NL",
  maximumConsentValidity: 180 * 86_400,
  requiredPsuHeaders: [],
  // Long enough that no window is refused: that has its own scenario.
  unattendedDays: 3650,
  ignoresStatusFilter: false,
  accounts: [{ iban: IBAN, transactions }],
});

type History = {
  // Transaction `t<n>` is entry n. Its versions are in the order they begin.
  transactions: FakeVersion[][];
  // Ids that never change.
  steady: Set<string>;
};

const amount = (random: Random): Raw => ({
  transaction_amount: { currency: "EUR", amount: `${random.int(1, 500)}.00` },
});

const history = (random: Random, lookback: number): History => {
  const made: History = { transactions: [], steady: new Set() };
  const count = random.int(0, 14);
  for (let index = 0; index < count; index++) {
    const id = `t${index}`;
    // Some transactions are older than the first authorisation.
    const appears = random.int(-20, NIGHTS - 2);
    // Banks book late, by at most the lookback: that is what the lookback is for.
    const date = addDays(dateOf(stamp(appears)), -random.int(0, lookback));
    const versions: FakeVersion[] = [
      { from: stamp(appears, -60), raw: booked(id, date, amount(random)) },
    ];
    if (random.chance(0.45)) {
      const from = stamp(random.int(appears + 1, NIGHTS - 1), -60);
      if (random.chance(0.3)) {
        versions.push({ from, raw: null });
      } else {
        const moved = random.chance(0.5) ? date : addDays(date, random.int(-40, 40));
        versions.push({ from, raw: booked(id, moved, amount(random)) });
      }
    } else {
      made.steady.add(id);
    }
    made.transactions.push(versions);
  }
  return made;
};

// Losing a run left in the inbox loses a version only when the bank changes a transaction
// that run was given before any later run asks for it again. Chance alone almost never
// arranges that, so it is arranged: after a run that leaves something in the inbox, the bank
// changes or withdraws one or two of the transactions it has just served. It prefers a
// version it had never served before, because one the archive already holds is not lost
// with the run. Returns how many it changed.
const changeServed = (
  random: Random,
  made: History,
  served: FakeBank["served"],
  since: number,
  from: string,
): number => {
  const earlier = served.slice(0, since).map((item) => item.raw);
  const given = served.slice(since).map((item) => item.raw);
  const first = given.filter((raw) => !earlier.some((old) => isDeepStrictEqual(old, raw)));
  const chosen = random.shuffle(first.length > 0 ? first : given).slice(0, random.int(1, 2));
  for (const raw of chosen) {
    const id = String(raw.entry_reference);
    const date = String(raw.booking_date);
    const versions = made.transactions[Number(id.slice(1))];
    const moved = random.chance(0.5) ? date : addDays(date, random.int(-40, 40));
    versions.push({ from, raw: random.chance(0.25) ? null : booked(id, moved, amount(random)) });
    // The bank answers with the last version in the list that has begun.
    versions.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    made.steady.delete(id);
  }
  return chosen.length;
};

// What the bank holds at an instant, worked out from the generator's own record and not by
// asking anything: of each transaction, the last version that has begun. A version of null
// means the bank has withdrawn it. No date limits this, because a session the user has just
// authorised reaches the whole history and `auth` asks for the longest period.
const holdingsAt = (
  made: History,
  at: string,
): { held: Map<string, Raw>; withdrawn: Set<string> } => {
  const held = new Map<string, Raw>();
  const withdrawn = new Set<string>();
  made.transactions.forEach((versions, index) => {
    const last = versions.findLast((version) => version.from <= at);
    if (last === undefined) return;
    if (last.raw === null) withdrawn.add(`t${index}`);
    else held.set(`t${index}`, last.raw);
  });
  return { held, withdrawn };
};

const byId = <T>(entries: Iterable<readonly [string, T]>): (readonly [string, T])[] =>
  [...entries].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const current = (records: readonly ArchiveRecord[]) =>
  new Map(records.map((record) => [record.id, [record.date, record.raw]]));

const shown = (records: readonly ArchiveRecord[]) =>
  view(records, {}).map((item) => ({ ...item, first_seen: "", revised: false }));

// How many of the versions the bank returned the archive holds neither as a record's current
// version nor as a revision.
const notHeld = (served: FakeBank["served"], stored: readonly ArchiveRecord[]): number =>
  served.filter(({ raw }) => {
    const record = stored.find((item) => item.id === String(raw.entry_reference));
    const versions =
      record === undefined ? [] : [record.raw, ...record.revisions.map((item) => item.raw)];
    return !versions.some((version) => isDeepStrictEqual(version, raw));
  }).length;

type Tally = {
  // Runs that died, by where.
  diedPageWritten: number;
  diedReceived: number;
  diedDataWritten: number;
  diedStateWritten: number;
  // Requests the bank failed, as the runs reported them.
  failed: number;
  // Runs of `sync` that exited 0.
  succeeded: number;
  // Transactions the bank changed right after a run that left something in the inbox.
  followed: number;
  // Incomplete runs that a later run merged.
  leftovers: number;
  // Times a run without its marker was found in the inbox holding two pages or more.
  longLeftovers: number;
  // Steady transactions that appeared after the first authorisation and were found in the
  // archive before the final backfill.
  steadyHeld: number;
  revised: number;
  withdrawnKept: number;
  // Runs with the account closed that began while a version the bank had returned was held
  // only by the inbox, which a sweep that failed would have stranded.
  stranded: number;
  // Inbox runs the sweep merged while the account was closed.
  swept: number;
};

const DIED: Record<Checkpoint, keyof Tally> = {
  "page-written": "diedPageWritten",
  received: "diedReceived",
  "data-written": "diedDataWritten",
  "state-written": "diedStateWritten",
};

const nothing = (): Tally => ({
  diedPageWritten: 0,
  diedReceived: 0,
  diedDataWritten: 0,
  diedStateWritten: 0,
  failed: 0,
  succeeded: 0,
  followed: 0,
  leftovers: 0,
  longLeftovers: 0,
  steadyHeld: 0,
  revised: 0,
  withdrawnKept: 0,
  stranded: 0,
  swept: 0,
});

const FAILED_REQUEST =
  /: (Enable Banking answered 500 ASPSP_ERROR|no answer from Enable Banking \(TypeError\))$/;
const DONE = /^done failed=(\d+) newly_missing=(\d+)$/;

type Scene = {
  seed: number;
  made: History;
  world: World;
  tally: Tally;
  // Runs of `sync` still to come with the account closed in the configuration.
  closed: number;
};

// One run of `sync`, and what its exit code has to be. A run with the account open fails
// for one reason only here, a request the bank failed, and otherwise exits 1 only to report
// records newly missing from a window, which the bank's changes do cause.
const runSync = async (
  { seed, world, tally }: Scene,
  point: Checkpoint | null,
  closed: boolean,
): Promise<void> => {
  const from = world.lines.length;
  const asked = world.bank.requests.length;
  // Whether, as the run begins, a version the bank returned is held by the inbox alone.
  const waiting = closed && notHeld(world.bank.served, await world.records(ACCOUNT)) > 0;
  const code = await world.run("sync");
  world.crashAt = null;
  const printed = world.lines.slice(from);
  if (code === CRASHED) {
    assert.ok(point !== null, `seed ${seed}: a run died that was not made to`);
    tally[DIED[point]] += 1;
    return;
  }
  if (closed) {
    // With its one account closed the run asks the bank nothing, and fails saying so, once it
    // has merged what waits. Nothing may be left waiting then: no fetch is coming to merge it.
    assert.equal(code, 1, `seed ${seed}: the exit code of a run with the account closed`);
    assert.equal(printed.at(-1), NOTHING_FETCHED, `seed ${seed}: a run with the account closed`);
    assert.equal(world.bank.requests.length, asked, `seed ${seed}: a closed account was fetched`);
    assert.equal(
      notHeld(world.bank.served, await world.records(ACCOUNT)),
      0,
      `seed ${seed}: with the account closed, a version the bank returned is not in the archive`,
    );
    if (waiting) tally.stranded += 1;
    tally.swept += printed.filter((line) => line.startsWith("merged ")).length;
    return;
  }
  const failures = printed.filter((line) => FAILED_REQUEST.test(line)).length;
  const done = printed.map((line) => DONE.exec(line)).find((match) => match !== null);
  assert.ok(done, `seed ${seed}: a run of sync ended without its last line`);
  const [failedAccounts, newlyMissing] = [Number(done[1]), Number(done[2])];
  assert.equal(failedAccounts, Math.min(failures, 1), `seed ${seed}: what failed in a run`);
  assert.equal(
    code,
    failedAccounts > 0 || newlyMissing > 0 ? 1 : 0,
    `seed ${seed}: the exit code of a run`,
  );
  tally.failed += failures;
  if (code === 0) tally.succeeded += 1;
};

// The nights, some of them skipped, some run twice, half of the runs disturbed.
const nights = async (scene: Scene, random: Random, lookback: number): Promise<void> => {
  const { seed, made, world, tally } = scene;
  for (let night = 1; night < NIGHTS; night++) {
    if (!random.chance(0.5)) continue;
    const runs = random.chance(0.15) ? 2 : 1;
    for (let run = 0; run < runs; run++) {
      world.at(stamp(night, run * 5));
      let point: Checkpoint | null = null;
      // Mostly small pages: a run that dies or fails part-way then leaves some pages
      // behind and not others.
      world.bank.pageSize = random.chance(0.7) ? random.int(1, 2) : random.int(3, 5);
      // Half the runs are disturbed: an undisturbed run costs as much and shows less.
      if (random.chance(0.5)) {
        if (random.chance(0.5)) {
          point = random.pick(POINTS);
          world.crashAt = point;
        } else {
          const failure = random.chance(0.5)
            ? { status: 500, error: "ASPSP_ERROR" }
            : ({ network: true } as const);
          // Up to the fourth request, and one transaction to a page, so that a fetch can
          // fail after more than one of its pages is on disk.
          world.bank.failRequest(random.int(1, 4), failure);
          world.bank.pageSize = 1;
        }
        // A run that is about to be disturbed is usually given something the archive
        // does not hold yet, because only that can be lost with the run: up to three
        // transactions that appear a minute before it, booked inside the lookback like
        // any other. Several, so that the fetch often takes several pages.
        const bookings = random.chance(0.8) ? random.int(1, 3) : 0;
        for (let booking = 0; booking < bookings; booking++) {
          const id = `t${made.transactions.length}`;
          const date = addDays(dateOf(stamp(night)), -random.int(0, lookback));
          made.transactions.push([
            { from: stamp(night, run * 5 - 1), raw: booked(id, date, amount(random)) },
          ]);
          made.steady.add(id);
        }
      }
      const since = world.bank.served.length;
      const closed = scene.closed > 0;
      await runSync(scene, point, closed);
      const left = await world.inbox(ACCOUNT);
      tally.longLeftovers += left.filter(
        (item) => item.marker === null && item.pages.length >= 2,
      ).length;
      // What follows depends on what the code under test left behind, so it draws from a
      // source of its own. `random` then gives the same bookings, changes and disturbances
      // for a seed whatever the code does.
      const bias = makeRandom(seed * 1000 + night * 2 + run);
      if (bias.chance(0.7) && left.length > 0) {
        const from = stamp(night, run * 5 + 1);
        tally.followed += changeServed(bias, made, world.bank.served, since, from);
      }
      if (closed) {
        scene.closed -= 1;
        if (scene.closed === 0) await setClosed(world, false);
      } else if (left.length > 0 && bias.chance(0.6)) {
        // A closed account is never fetched, so what a run left in its inbox is merged by the
        // sweep or by nothing. Only a closing right after such a run tests that, so that is
        // when the account is closed, often, for the next run or two.
        scene.closed = bias.int(1, 2);
        await setClosed(world, true);
      }
    }
  }
  // The final backfill authorises the account, which it can only do while it is open.
  if (scene.closed > 0) {
    scene.closed = 0;
    await setClosed(world, false);
  }
};

// Before the final backfill, which would repair it: a transaction that never changed and
// that the bank had by the last fetch recorded as a success is already in the archive.
const checkBeforeBackfill = async ({ seed, made, world, tally }: Scene): Promise<void> => {
  const reached = (await world.state("bnka"))?.accounts[ACCOUNT]?.last_success;
  assert.ok(reached !== undefined, `seed ${seed}: no fetch is recorded as a success`);
  const before = new Set((await world.records(ACCOUNT)).map((record) => record.id));
  made.transactions.forEach((versions, index) => {
    const id = `t${index}`;
    if (!made.steady.has(id) || versions[0].from > reached) return;
    assert.ok(
      before.has(id),
      `seed ${seed}: ${id} was at the bank by the last full fetch and is not in the archive`,
    );
    if (versions[0].from > stamp(0)) tally.steadyHeld += 1;
  });
};

// The state is lost, and the user authorises again: a full backfill, which has to succeed.
// It may exit 1, to report records missing from a window that a run left in the inbox had
// asked for, and for nothing else.
const backfill = async ({ seed, world }: Scene): Promise<void> => {
  world.bank.clearFailures();
  world.at(stamp(NIGHTS));
  await rm(join(world.stateDir, "bnka.json"));
  const from = world.lines.length;
  const code = await world.run("auth", "bnka");
  const printed = world.lines.slice(from);
  assert.ok(code === 0 || code === 1, `seed ${seed}: the last backfill`);
  assert.ok(
    !printed.some((line) => line.includes("Not fetched in full")),
    `seed ${seed}: the last backfill did not fetch the account in full`,
  );
  assert.deepEqual(await world.inbox(ACCOUNT), [], `seed ${seed}: the inbox after the backfill`);
  assert.equal(
    (await world.state("bnka"))?.accounts[ACCOUNT]?.last_success,
    stamp(NIGHTS),
    `seed ${seed}: the success the last backfill recorded`,
  );
};

const checkFinal = async (scene: Scene, fresh: World): Promise<void> => {
  const { seed, made, world, tally } = scene;
  const stored = await world.records(ACCOUNT);
  const { held, withdrawn } = holdingsAt(made, stamp(NIGHTS));
  const kept = stored.filter((record) => !withdrawn.has(record.id));

  // Convergence, against the generator: apart from what the bank withdrew, the archive's
  // current versions are exactly what the bank holds.
  assert.deepEqual(
    byId(kept.map((record) => [record.id, record.raw] as const)),
    byId(held),
    `seed ${seed}: what is stored, against what the bank holds`,
  );

  // Convergence, against a single fetch: a second machine that has never run asks once,
  // and stores and shows the same.
  assert.equal(await fresh.run("auth", "bnka"), 0, `seed ${seed}: the single fetch`);
  const expected = await fresh.records(ACCOUNT);
  assert.deepEqual(current(kept), current(expected), `seed ${seed}: what is stored`);
  assert.deepEqual(shown(kept), shown(expected), `seed ${seed}: what is shown`);

  // Nothing is lost: every version the bank ever returned is the current one or a
  // revision, a withdrawn transaction included.
  assert.equal(
    notHeld(world.bank.served, stored),
    0,
    `seed ${seed}: a version the bank returned is not in the archive`,
  );
  const served = new Map<string, Raw[]>();
  for (const { raw } of world.bank.served) {
    const id = String(raw.entry_reference);
    served.set(id, [...(served.get(id) ?? []), raw]);
  }

  // Nothing is made up either. A record holds only versions the bank returned, its current
  // one is the last the bank returned, and no version is stored twice in a row. A version
  // may come back after another, since the bank can change a transaction back, so the rule
  // is about neighbours and not about repeats.
  for (const record of stored) {
    const returned = served.get(record.id) ?? [];
    const versions = [...record.revisions.map((item) => item.raw), record.raw];
    assert.ok(
      versions.every((version) => returned.some((raw) => isDeepStrictEqual(raw, version))),
      `seed ${seed}: the archive holds a version the bank never returned`,
    );
    assert.ok(
      isDeepStrictEqual(record.raw, returned.at(-1)),
      `seed ${seed}: a record's current version is not the last the bank returned`,
    );
    assert.ok(
      versions.every(
        (version, index) => index === 0 || !isDeepStrictEqual(version, versions[index - 1]),
      ),
      `seed ${seed}: the archive holds a version twice in a row`,
    );
  }

  tally.leftovers = world.lines.filter((line) => line.includes("complete=no")).length;
  tally.revised = stored.filter((record) => record.revisions.length > 0).length;
  tally.withdrawnKept = stored.length - kept.length;
};

const converge = async (seed: number): Promise<Tally> => {
  const random = makeRandom(seed);
  const lookback = random.pick([0, 3, 30]);
  const made = history(random, lookback);
  const world = await makeWorld({
    config,
    aspsps: [bankWith(made.transactions)],
    start: stamp(0),
    env: { LOOKBACK_DAYS: String(lookback) },
  });
  // A second machine that has never run, for the single fetch of the final state.
  const fresh = await makeWorld({
    config,
    aspsps: [bankWith(made.transactions)],
    start: stamp(NIGHTS),
  });
  const scene: Scene = { seed, made, world, tally: nothing(), closed: 0 };
  try {
    world.bank.pageSize = random.int(1, 5);
    assert.equal(await world.run("auth", "bnka"), 0, `seed ${seed}: the first authorisation`);
    await nights(scene, random, lookback);
    await checkBeforeBackfill(scene);
    await backfill(scene);
    await checkFinal(scene, fresh);
    return scene.tally;
  } finally {
    await world.cleanup();
    await fresh.cleanup();
  }
};

test("however the nights fall and wherever a run dies, the archive converges and nothing is lost", async () => {
  const total: Tally = nothing();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const tally = await converge(seed);
    for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += tally[key];
  }
  // Without these the property could pass on worlds that never test it, so every count has
  // a floor: three of each, and many runs that simply succeed. Observed with the generator
  // as written, over 9 seeds of 20 nights: 4 runs died at `page-written`, 6 at `received`,
  // 4 at `data-written` and 3 at `state-written`; the bank failed 16 requests; 42 runs
  // exited 0; 20 transactions were changed right after a run that left something in the
  // inbox; 13 incomplete runs were merged later, and 6 times an incomplete run held two
  // pages or more; 43 steady transactions that appeared after the first authorisation were
  // found before the final backfill; 17 records were revised and 13 withdrawn records
  // kept; the sweep merged 13 runs with the account closed, and 8 runs with it closed began
  // with a version that only the inbox held. The test takes about 13 seconds on its own, as
  // long as before the account was ever closed, and about three times that beside the rest
  // of the suite.
  //
  // Each of six deliberate breaks made the property itself fail, before these floors were
  // reached, mostly with "with the account closed, a version the bank returned is not in the
  // archive". A sweep that passes over closed accounts: seeds 1, 3, 6, 7 and 8. A sync that
  // does not sweep when no account is fetched: the same seeds. Dropping an incomplete run:
  // seeds 1, 6, 7 and 8. Merging only the first page of an incomplete run: seeds 1, 6 and 8.
  // Merging only the run just received: seeds 1 and 5, and seed 2 with "a version the bank
  // returned is not in the archive". Ignoring the lookback: seeds 1 to 5, "was at the bank by
  // the last full fetch and is not in the archive".
  //
  // Closing the account moved some of those, since a closed run fetches nothing and the
  // sweep merges what a fetch would have. Before it, merging only the run just received
  // failed seeds 1, 2, 3, 5, 6 and 8, and ignoring the lookback seeds 1 to 6.
  //
  // Those seed lists hold for this generator and for the requests production makes today.
  // `random` gives the same schedule for a seed whatever the code does, but a failure is
  // placed by counting requests, so a change to how production asks moves it. After a
  // change to either, the breaks have to be tried again.
  for (const [what, count] of Object.entries(total)) {
    const least = what === "succeeded" ? 25 : 3;
    assert.ok(
      count >= least,
      `${SEEDS} seeds had ${count} ${what}, and at least ${least} are wanted`,
    );
  }
});
