import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { deepEqual, view } from "@money/shared";
import type { ArchiveRecord, Config } from "@money/shared";
import { makeRandom } from "@money/shared/testing";
import type { Random } from "@money/shared/testing";

import type { FakeAspsp, FakeBank, FakeVersion } from "../testing/fake-bank.ts";
import { booked, CRASHED, makeWorld } from "../testing/world.ts";
import type { Checkpoint } from "./context.ts";
import { addDays, dateOf, timestampOf } from "./time.ts";

const SEEDS = 8;
const NIGHTS = 45;
const DAY = 86_400_000;
// Early December, so that the nights cross a year boundary.
const START = Date.parse("2025-12-05T03:00:00Z");
const IBAN = "NL00BNKA0000000001";
const ACCOUNT = "bnka-current";
const POINTS: Checkpoint[] = ["page-written", "received", "data-written", "state-written"];

const config: Config = {
  banks: { bnka: { aspsp: { name: "Example Bank", country: "NL" } } },
  accounts: { [ACCOUNT]: { bank: "bnka", iban: IBAN } },
  imports: {},
};

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
  transactions: FakeVersion[][];
  // Ids that never change, and ids the bank withdraws.
  steady: Set<string>;
  withdrawn: Set<string>;
};

const amount = (random: Random): Record<string, unknown> => ({
  transaction_amount: { currency: "EUR", amount: `${random.int(1, 500)}.00` },
});

const history = (random: Random, lookback: number): History => {
  const made: History = { transactions: [], steady: new Set(), withdrawn: new Set() };
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
        made.withdrawn.add(id);
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
// changes or withdraws one or two of the transactions it has just served, preferring a
// version it had never served before. Returns how many it changed.
const changeServed = (
  random: Random,
  made: History,
  served: FakeBank["served"],
  since: number,
  from: string,
): number => {
  const earlier = served.slice(0, since).map((item) => item.raw);
  const given = served.slice(since).map((item) => item.raw);
  const first = given.filter((raw) => !earlier.some((old) => deepEqual(old, raw)));
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
    if (versions[versions.length - 1].raw === null) made.withdrawn.add(id);
    else made.withdrawn.delete(id);
  }
  return chosen.length;
};

const current = (records: readonly ArchiveRecord[]) =>
  new Map(records.map((record) => [record.id, [record.date, record.raw]]));

const shown = (records: readonly ArchiveRecord[]) =>
  view(records, {}).map((item) => ({ ...item, first_seen: "", revised: false }));

type Tally = {
  crashes: number;
  failures: number;
  // Transactions the bank changed right after a run that left something in the inbox.
  followed: number;
  leftovers: number;
  revised: number;
  withdrawnKept: number;
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
  const tally: Tally = {
    crashes: 0,
    failures: 0,
    followed: 0,
    leftovers: 0,
    revised: 0,
    withdrawnKept: 0,
  };
  try {
    world.bank.pageSize = random.int(1, 5);
    assert.equal(await world.run("auth", "bnka"), 0, `seed ${seed}: the first authorisation`);

    for (let night = 1; night < NIGHTS; night++) {
      if (!random.chance(0.5)) continue;
      const runs = random.chance(0.15) ? 2 : 1;
      for (let run = 0; run < runs; run++) {
        world.at(stamp(night, run * 5));
        if (random.chance(0.3)) {
          if (random.chance(0.5)) {
            world.crashAt = random.pick(POINTS);
          } else {
            const failure = random.chance(0.5)
              ? { status: 500, error: "ASPSP_ERROR" }
              : ({ network: true } as const);
            world.bank.failRequest(random.int(1, 2), failure);
            tally.failures += 1;
          }
          // A run that is about to be disturbed is usually given something the archive
          // does not hold yet: a transaction booked that day, a minute before the run.
          if (random.chance(0.8)) {
            const id = `t${made.transactions.length}`;
            const today = dateOf(stamp(night));
            made.transactions.push([
              { from: stamp(night, run * 5 - 1), raw: booked(id, today, amount(random)) },
            ]);
            made.steady.add(id);
          }
        }
        const since = world.bank.served.length;
        if ((await world.run("sync")) === CRASHED) tally.crashes += 1;
        world.crashAt = null;
        if ((await world.inbox(ACCOUNT)).length > 0 && random.chance(0.7)) {
          const from = stamp(night, run * 5 + 1);
          tally.followed += changeServed(random, made, world.bank.served, since, from);
        }
      }
    }

    // Before the final backfill, which would repair it: a transaction that never changed
    // and that the bank had by the last fetch recorded as a success is already here.
    const reached = (await world.state("bnka"))?.accounts[ACCOUNT].last_success ?? "";
    const before = new Set((await world.records(ACCOUNT)).map((record) => record.id));
    made.transactions.forEach((versions, index) => {
      const id = `t${index}`;
      if (!made.steady.has(id) || versions[0].from > reached) return;
      assert.ok(
        before.has(id),
        `seed ${seed}: ${id} was at the bank by the last full fetch and is not in the archive`,
      );
    });

    // The state is lost, and the user authorises again: a full backfill.
    world.bank.clearFailures();
    world.at(stamp(NIGHTS));
    await rm(join(world.stateDir, "bnka.json"));
    assert.notEqual(await world.run("auth", "bnka"), CRASHED, `seed ${seed}: the last backfill`);
    assert.equal(await fresh.run("auth", "bnka"), 0, `seed ${seed}: the single fetch`);

    const stored = await world.records(ACCOUNT);
    const expected = await fresh.records(ACCOUNT);
    const kept = stored.filter((record) => !made.withdrawn.has(record.id));

    // Convergence: apart from what the bank withdrew, the archive shows exactly what one
    // fetch of the final state shows.
    assert.deepEqual(current(kept), current(expected), `seed ${seed}: what is stored`);
    assert.deepEqual(shown(kept), shown(expected), `seed ${seed}: what is shown`);

    // Nothing is lost: every version the bank ever returned is the current one or a
    // revision, a withdrawn transaction included.
    for (const { raw } of world.bank.served) {
      const record = stored.find((item) => item.id === raw.entry_reference);
      const versions =
        record === undefined ? [] : [record.raw, ...record.revisions.map((item) => item.raw)];
      assert.ok(
        versions.some((version) => deepEqual(version, raw)),
        `seed ${seed}: a version the bank returned is not in the archive`,
      );
    }

    tally.leftovers = world.lines.filter((line) => line.includes("complete=no")).length;
    tally.revised = stored.filter((record) => record.revisions.length > 0).length;
    tally.withdrawnKept = stored.length - kept.length;
    return tally;
  } finally {
    await world.cleanup();
    await fresh.cleanup();
  }
};

test("however the nights fall and wherever a run dies, the archive converges and nothing is lost", async () => {
  const total: Tally = {
    crashes: 0,
    failures: 0,
    followed: 0,
    leftovers: 0,
    revised: 0,
    withdrawnKept: 0,
  };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const tally = await converge(seed);
    for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += tally[key];
  }
  // Without these the property could pass on worlds that never test it. Observed with the
  // generator as written, over 8 seeds of 45 nights: 30 runs died at a checkpoint, 26
  // request failures were scheduled, 19 transactions were changed right after a run that
  // left something in the inbox, 10 incomplete runs were merged later, 18 records were
  // revised, 8 withdrawn records kept.
  // Each of three deliberate breaks made the property itself fail, in at least two seeds,
  // before this check was reached. Dropping an incomplete run: seeds 6 and 8, "a version
  // the bank returned is not in the archive". Merging only the run just received: seeds 1,
  // 5, 6 and 8, with the same message. Ignoring the lookback: seeds 4 and 5, "was at the
  // bank by the last full fetch and is not in the archive".
  for (const [what, count] of Object.entries(total)) {
    assert.ok(count > 0, `no run in ${SEEDS} seeds had any ${what}`);
  }
});
