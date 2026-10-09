import assert from "node:assert/strict";
import { test } from "node:test";

import { aFormat, anApiRaw, anImportRaw } from "../../testing/factories.ts";
import { makeRandom } from "../../testing/random.ts";
import type { Random } from "../../testing/random.ts";
import { merge } from "./merge.ts";
import type { Incoming, Target } from "./merge.ts";
import { identityOf } from "./record.ts";
import type { ArchiveRecord } from "./record.ts";
import { apiStarts, view } from "./view.ts";

const FORMATS = { "example-export": aFormat() };
const ACCOUNTS = ["bnka-current", "bnka-joint"];
const RUNS = 300;

const day = (random: Random): string =>
  `2025-${String(random.int(1, 3)).padStart(2, "0")}-${String(random.int(1, 28)).padStart(2, "0")}`;

type Feed = { target: Target; items: Incoming[] };

// For each account, a set of imported transactions and a set of fetched ones, with dates
// that overlap. Ids are unique within a feed and say nothing about the contents.
const world = (random: Random): Feed[] =>
  ACCOUNTS.flatMap((account): Feed[] => [
    {
      target: { account, source: "import", format: "example-export" },
      items: Array.from({ length: random.int(0, 12) }, (_, index) => {
        const date = day(random);
        return { id: `i${index}`, date, raw: anImportRaw({ Sequence: `i${index}`, Booked: date }) };
      }),
    },
    {
      target: { account, source: "api" },
      items: Array.from({ length: random.int(0, 12) }, (_, index) => {
        const date = day(random);
        return {
          id: `a${index}`,
          date,
          raw: anApiRaw({ entry_reference: `a${index}`, booking_date: date }),
        };
      }),
    },
  ]);

// Covers `items` with overlapping batches: every item is in at least one, many in several.
const batches = (random: Random, items: readonly Incoming[]): Incoming[][] => {
  const count = random.int(1, 4);
  const result: Incoming[][] = Array.from({ length: count }, () => []);
  for (const item of items) {
    result[random.int(0, count - 1)].push(item);
    for (const batch of result) if (random.chance(0.3) && !batch.includes(item)) batch.push(item);
  }
  return result;
};

const withoutTimes = (records: readonly ArchiveRecord[]) =>
  view(records, FORMATS).map((item) => ({ ...item, first_seen: "" }));

const inOneGo = (feeds: readonly Feed[]): ArchiveRecord[] =>
  feeds.flatMap((feed) => merge([], feed.items, feed.target, "2025-06-01T03:00:00Z").records);

test("with one version of each transaction, any overlapping batches in any order give the same view", () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = makeRandom(seed);
    const feeds = world(random);
    const steps = random.shuffle(
      feeds.flatMap((feed) =>
        batches(random, feed.items).map((items) => ({ target: feed.target, items })),
      ),
    );
    const stored = new Map<string, ArchiveRecord[]>();
    steps.forEach((step, index) => {
      const key = `${step.target.account}/${step.target.source}`;
      const now = `2025-06-${String(1 + (index % 28)).padStart(2, "0")}T03:00:00Z`;
      stored.set(
        key,
        merge(stored.get(key) ?? [], random.shuffle(step.items), step.target, now).records,
      );
    });
    assert.deepEqual(
      withoutTimes([...stored.values()].flat()),
      withoutTimes(inOneGo(feeds)),
      `seed ${seed}`,
    );
  }
});

// A bank history for one feed: each id has one to three versions, each current from an
// instant (a day number in June) onward. A later version may change the amount, the date,
// or both, and the date can land in another month or on the other side of the API start.
type Version = { at: number; date: string; raw: Incoming["raw"] };
type History = { target: Target; ids: { id: string; versions: Version[] }[] };

const instant = (at: number): string => `2025-06-${String(at).padStart(2, "0")}T03:00:00Z`;
const LAST = 20;

const versionOf = (target: Target, id: string, at: number, date: string, cents: number): Version =>
  target.source === "api"
    ? {
        at,
        date,
        raw: anApiRaw({
          entry_reference: id,
          booking_date: date,
          transaction_amount: { currency: "EUR", amount: `${cents}.00` },
        }),
      }
    : {
        at,
        date,
        raw: anImportRaw({ Sequence: id, Booked: date, Amount: `-${cents},00` }),
      };

const histories = (random: Random): History[] =>
  world(random).map((feed) => ({
    target: feed.target,
    ids: feed.items.map((item) => {
      const count = random.chance(0.3) ? random.int(2, 3) : 1;
      const ats = random.shuffle(Array.from({ length: LAST - 2 }, (_, index) => index + 1));
      const sorted = ats.slice(0, count).toSorted((a, b) => a - b);
      let date = item.date;
      return {
        id: item.id,
        versions: sorted.map((at, index) => {
          if (index > 0 && random.chance(0.7)) date = day(random);
          return versionOf(feed.target, item.id, at, date, random.int(1, 500));
        }),
      };
    }),
  }));

const currentAt = (versions: readonly Version[], at: number): Version | undefined =>
  versions.findLast((version) => version.at <= at);

const finalVersions = (history: History): Incoming[] =>
  history.ids.map(({ id, versions }) => ({ id, ...versions[versions.length - 1] }));

test("however the nights fall, the archive ends up showing the same transactions", () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = makeRandom(seed);
    const all = histories(random);
    const stored: ArchiveRecord[] = [];
    const expected: ArchiveRecord[] = [];
    for (const history of all) {
      const nights = [
        ...[...Array(LAST - 1).keys()].map((index) => index + 1).filter(() => random.chance(0.4)),
        LAST,
      ];
      let records: ArchiveRecord[] = [];
      for (const night of nights) {
        const batch = history.ids.flatMap(({ id, versions }) => {
          const current = currentAt(versions, night);
          if (current === undefined) return [];
          return night === LAST || random.chance(0.6) ? [{ id, ...current }] : [];
        });
        records = merge(records, random.shuffle(batch), history.target, instant(night)).records;
      }
      stored.push(...records);
      expected.push(...merge([], finalVersions(history), history.target, instant(LAST)).records);
    }
    const settle = (records: readonly ArchiveRecord[]) =>
      view(records, FORMATS).map((item) => ({ ...item, first_seen: "", revised: false }));
    assert.deepEqual(settle(stored), settle(expected), `seed ${seed}`);
    const contents = (records: readonly ArchiveRecord[]) =>
      new Map(records.map((record) => [identityOf(record), [record.date, record.raw]]));
    assert.deepEqual(contents(stored), contents(expected), `seed ${seed}`);
  }
});

test("merging the same batch again changes nothing", () => {
  for (let seed = 1; seed <= RUNS; seed++) {
    const random = makeRandom(seed);
    for (const feed of world(random)) {
      const once = merge([], feed.items, feed.target, "2025-06-01T03:00:00Z");
      const twice = merge(
        once.records,
        random.shuffle(feed.items),
        feed.target,
        "2025-06-02T03:00:00Z",
      );
      assert.deepEqual(twice.records, once.records, `seed ${seed}`);
      assert.deepEqual(twice.added, [], `seed ${seed}`);
      assert.deepEqual(twice.revised, [], `seed ${seed}`);
    }
  }
});

test("the view shows every fetched transaction and exactly the imports before the API start", () => {
  let withKeptImport = 0;
  let overlaps = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const feeds = world(makeRandom(seed));
    const records = inOneGo(feeds);

    // The expected answer comes from the generated feeds, not from the code under test.
    const expectedStarts: Record<string, string> = {};
    for (const feed of feeds) {
      if (feed.target.source !== "api") continue;
      for (const item of feed.items) {
        const current = expectedStarts[feed.target.account];
        if (current === undefined || item.date < current) {
          expectedStarts[feed.target.account] = item.date;
        }
      }
    }
    assert.deepEqual(
      Object.fromEntries(apiStarts(records)),
      expectedStarts,
      `seed ${seed}: API starts`,
    );

    const expectedVisible: string[] = [];
    let keptBeforeStart = false;
    for (const feed of feeds) {
      const start = expectedStarts[feed.target.account];
      for (const item of feed.items) {
        const identity = identityOf({ ...feed.target, id: item.id });
        if (feed.target.source === "api" || start === undefined || item.date < start) {
          expectedVisible.push(identity);
          if (feed.target.source === "import" && start !== undefined) keptBeforeStart = true;
        }
      }
    }
    if (keptBeforeStart) withKeptImport += 1;
    if (view(records, FORMATS).length < records.length) overlaps += 1;
    assert.deepEqual(
      view(records, FORMATS)
        .map((item) => identityOf(item))
        .toSorted(),
      expectedVisible.toSorted(),
      `seed ${seed}: visible transactions`,
    );
  }
  // Without these checks the property could pass on worlds that never test one direction.
  // Observed with the generator as written: something to hide in 294 of 300 runs,
  // and an import kept in an account that also has API records in 205 of 300.
  assert.ok(overlaps > RUNS / 2, `only ${overlaps} of ${RUNS} runs had anything to hide`);
  assert.ok(withKeptImport > RUNS / 3, `only ${withKeptImport} of ${RUNS} runs kept an import`);
});
