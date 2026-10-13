// The import's signature property: one export, cut into overlapping files that are written
// in different dialects and imported in any order, one of them twice, gives the view that
// one import of the whole gives. The expected view is built from the generated rows alone,
// never through the reader.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { normalise } from "@money/shared";
import type { Transaction } from "@money/shared";
import { readArchive } from "@money/shared/node";
import { aFormat, anImportRaw, makeRandom } from "@money/shared/testing";

import { renderExport } from "../../testing/export.ts";
import { makeWorld, worldConfig } from "../../testing/world.ts";
import { addDays } from "../time.ts";

const FORMAT = "example-export";
const HEADER = Object.keys(anImportRaw());
const SEEDS = [11, 12, 13, 14, 15, 16];
const ROWS = 40;

// Text that a careless reader gets wrong: the delimiter, quotes, a line break, padding,
// letters beyond ASCII, and nothing at all.
const TEXTS = [
  "Plain text",
  "Semi; colon",
  'Said "so"',
  "Two\nlines",
  " padded ",
  "Café €",
  "",
  " ",
];
// One account, written the ways a person might write it.
const CURRENT = ["NL00BNKA0000000001", "nl00bnka0000000001", "NL00 BNKA 0000 0000 01"];

type Generated = { cells: string[]; expected: Transaction };

// What the view shows of a text cell, worked out here and not by the code under test.
const shown = (text: string): string | null => (text.trim() === "" ? null : text.trim());

const generate = (seed: number): Generated[] => {
  const random = makeRandom(seed);
  // Each account numbers its own rows, so the two share identifiers.
  const next = { "bnka-current": 0, "bnka-card": 0 };
  return Array.from({ length: ROWS }, () => {
    const account = random.chance(0.3) ? "bnka-card" : "bnka-current";
    next[account] += 1;
    const id = String(next[account]).padStart(6, "0");
    // Twenty days around a year boundary.
    const date = addDays("2024-12-22", random.int(0, 20));
    const cents = random.int(1, 99_999) * (random.chance(0.6) ? -1 : 1);
    const sign = cents < 0 ? "-" : random.chance(0.5) ? "+" : "";
    const whole = Math.floor(Math.abs(cents) / 100);
    const fraction = String(Math.abs(cents) % 100).padStart(2, "0");
    const name = random.pick(TEXTS);
    const text = random.pick(TEXTS);
    const raw = anImportRaw({
      Account: account === "bnka-card" ? "1001" : random.pick(CURRENT),
      Sequence: id,
      Booked: date,
      "Value date": date,
      Amount: `${sign}${whole},${fraction}`,
      Counterparty: name,
      "Counterparty account": "",
      Type: "",
      "Text 1": text,
      "Text 2": "",
      "Text 3": "",
    });
    return {
      cells: Object.values(raw),
      expected: {
        account,
        source: "import",
        id,
        date,
        value_date: date,
        amount: cents,
        currency: "EUR",
        counterparty_name: shown(name),
        counterparty_account: null,
        description: shown(text) ?? "",
        code: null,
        original_amount: null,
        original_currency: null,
        first_seen: "",
        revised: false,
      },
    };
  });
};

const inOrder = (transactions: Transaction[]): Transaction[] =>
  transactions.toSorted((a, b) => (`${a.account}/${a.id}` < `${b.account}/${b.id}` ? -1 : 1));

const seen = { files: 0, delimiterInCell: 0, lineBreak: 0, withoutFinalEol: 0, repeated: 0 };

for (const seed of SEEDS) {
  test(`overlapping exports in any order converge on one import of the whole (seed ${seed})`, async (t) => {
    const world = await makeWorld({
      config: { ...worldConfig(), imports: { [FORMAT]: aFormat() } },
    });
    t.after(world.cleanup);
    const random = makeRandom(seed * 7919);
    const rows = generate(seed);

    // Three files that together hold every row, three more that overlap them at random,
    // and one of the six again.
    const a = random.int(1, rows.length - 2);
    const b = random.int(a + 1, rows.length - 1);
    const ranges: [number, number][] = [
      [0, a],
      [a, b],
      [b, rows.length],
    ];
    for (let extra = 0; extra < 3; extra += 1) {
      const from = random.int(0, rows.length - 1);
      ranges.push([from, random.int(from + 1, rows.length)]);
    }
    const schedule = [...random.shuffle(ranges), random.pick(ranges)];
    seen.repeated += 1;

    for (const [index, [from, to]] of schedule.entries()) {
      const slice = random.shuffle(rows.slice(from, to));
      const finalEol = random.chance(0.7);
      const text = renderExport(
        HEADER,
        slice.map((row) => row.cells),
        { eol: random.pick(["\r\n", "\n"]), finalEol, quote: () => random.chance(0.4) },
      );
      seen.files += 1;
      if (!finalEol) seen.withoutFinalEol += 1;
      const holds = (part: string): boolean =>
        slice.some((row) => row.cells.some((cell) => cell.includes(part)));
      if (holds(";")) seen.delimiterInCell += 1;
      if (holds("\n")) seen.lineBreak += 1;

      const path = join(dirname(world.dataDir), `export-${index}.csv`);
      await writeFile(path, text);
      world.at(`2026-03-${String(index + 1).padStart(2, "0")}T10:00:00Z`);
      world.lines.length = 0;
      const code = await world.run("import", FORMAT, path, "--write");
      assert.equal(code, 0, `seed ${seed}, file ${index}: ${world.lines.join(" | ")}`);
    }

    const actual = (await readArchive(world.dataDir)).map((record) => ({
      ...normalise(record, world.config.imports),
      first_seen: "",
    }));
    assert.deepEqual(inOrder(actual), inOrder(rows.map((row) => row.expected)), `seed ${seed}`);
  });
}

test("the schedules reach what the property exists for", () => {
  assert.equal(seen.files, SEEDS.length * 7);
  assert.equal(seen.repeated, SEEDS.length);
  assert.ok(seen.delimiterInCell > 0, "no file held the delimiter inside a cell");
  assert.ok(seen.lineBreak > 0, "no file held a line break inside a cell");
  assert.ok(seen.withoutFinalEol > 0, "every file ended with a line ending");
});
