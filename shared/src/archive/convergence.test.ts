import assert from "node:assert/strict";
import { test } from "node:test";

import { aFormat, anApiRaw, anImportRaw } from "../../testing/factories.ts";
import { makeRandom } from "../../testing/random.ts";
import type { Random } from "../../testing/random.ts";
import { merge } from "./merge.ts";
import type { Incoming, Target } from "./merge.ts";
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

test("however the batches fall and in whatever order, the view is the same", () => {
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

test("nothing fetched is ever hidden, and no import shows from the API start onward", () => {
  let overlaps = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const records = inOneGo(world(makeRandom(seed)));
    const starts = apiStarts(records);
    const shown = view(records, FORMATS);
    const fetched = records.filter((record) => record.source === "api").length;
    assert.equal(shown.filter((item) => item.source === "api").length, fetched, `seed ${seed}`);
    for (const item of shown) {
      if (item.source !== "import") continue;
      const start = starts.get(item.account);
      assert.ok(start === undefined || item.date < start, `seed ${seed}`);
    }
    if (shown.length < records.length) overlaps += 1;
  }
  // The property is only worth something if the generator actually produces overlap.
  assert.ok(overlaps > RUNS / 2, `only ${overlaps} of ${RUNS} runs had anything to hide`);
});
