import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord } from "../../testing/factories.ts";
import { renderYearFiles } from "./files.ts";
import { ArchiveError } from "./record.ts";
import type { ArchiveRecord } from "./record.ts";
import { planWrites } from "./writes.ts";
import type { WriteStep } from "./writes.ts";

const where = { account: "bnka-current", source: "api" } as const;
const rec = (id: string, date: string): ArchiveRecord => anApiRecord({ id, date });
const plan = (before: ArchiveRecord[], after: ArchiveRecord[]) =>
  planWrites(renderYearFiles(before), renderYearFiles(after), where);
const describe = (steps: WriteStep[]) => steps.map((step) => `${step.kind} ${step.name}`);

test("an unchanged set gives no steps", () => {
  const set = [rec("a", "2025-01-01"), rec("b", "2026-01-01")];
  assert.deepEqual(plan(set, set), []);
});

test("a new file and a grown file give one write each", () => {
  const a = rec("a", "2025-01-01");
  assert.deepEqual(describe(plan([a], [a, rec("b", "2025-02-01"), rec("c", "2026-01-01")])), [
    "write 2025.json",
    "write 2026.json",
  ]);
});

test("a record moving to a later year is written there before its old file shrinks", () => {
  const a = rec("a", "2025-01-01");
  const b = rec("b", "2025-02-01");
  assert.deepEqual(describe(plan([a, b], [b, { ...a, date: "2026-01-01" }])), [
    "write 2026.json",
    "write 2025.json",
  ]);
});

test("a record moving to an earlier year is written there before its old file shrinks", () => {
  const a = rec("a", "2026-01-01");
  const b = rec("b", "2026-02-01");
  assert.deepEqual(describe(plan([a, b], [b, { ...a, date: "2025-01-01" }])), [
    "write 2025.json",
    "write 2026.json",
  ]);
});

test("a swap writes both files as unions, then as their final text", () => {
  const a = rec("a", "2025-01-01");
  const b = rec("b", "2026-01-01");
  const steps = plan(
    [a, b],
    [
      { ...a, date: "2026-02-01" },
      { ...b, date: "2025-02-01" },
    ],
  );
  assert.deepEqual(describe(steps), [
    "write 2025.json",
    "write 2026.json",
    "write 2025.json",
    "write 2026.json",
  ]);
  const first = steps[0];
  assert.equal(first.kind === "write" && first.text.includes('"a"'), true);
  assert.equal(first.kind === "write" && first.text.includes('"b"'), true);
});

test("a file emptied by a move is removed, last", () => {
  const a = rec("a", "2025-01-01");
  assert.deepEqual(describe(plan([a], [{ ...a, date: "2026-01-01" }])), [
    "write 2026.json",
    "remove 2025.json",
  ]);
});

// A small seeded generator (mulberry32).
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

test("after every step, every stored id is still in some file", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const random = seeded(seed);
    const years = ["2024", "2025", "2026"];
    const count = 1 + Math.floor(random() * 8);
    const before = Array.from({ length: count }, (_, i) =>
      rec(`id-${i}`, `${years[Math.floor(random() * 3)]}-0${1 + Math.floor(random() * 9)}-01`),
    );
    const after = before.map((record) =>
      random() < 0.5
        ? {
            ...record,
            date: `${years[Math.floor(random() * 3)]}-0${1 + Math.floor(random() * 9)}-01`,
          }
        : record,
    );
    for (let i = 0; i < Math.floor(random() * 3); i++) after.push(rec(`new-${i}`, "2025-05-01"));

    const existing = renderYearFiles(before);
    const next = renderYearFiles(after);
    const disk = new Map(existing);
    const fail = (message: string) => `seed ${seed}: ${message}`;
    for (const step of planWrites(existing, next, where)) {
      if (step.kind === "write") disk.set(step.name, step.text);
      else disk.delete(step.name);
      const stored = [...disk.values()].join("");
      for (const record of before) {
        assert.ok(stored.includes(`"id": "${record.id}"`), fail(`${record.id} lost`));
      }
    }
    assert.deepEqual(disk, next, fail("final state differs"));
  }
});

test("a next set that would drop a stored id is refused, with a count only", () => {
  const set = [rec("secret-a", "2025-01-01"), rec("secret-b", "2025-02-01")];
  assert.throws(
    () => plan(set, [set[0]]),
    (error: unknown) =>
      error instanceof ArchiveError &&
      error.message === "bnka-current/api: writing would delete 1 stored record(s)",
  );
});

test("an empty next set over stored records is refused", () => {
  assert.throws(() => plan([rec("a", "2025-01-01")], []), /would delete 1 stored record/);
});

test("a bad file name, a repeated id and unreadable text are refused", () => {
  const good = renderYearFiles([rec("a", "2025-01-01")]);
  const text = good.get("2025.json") ?? "";
  assert.throws(() => planWrites(new Map(), new Map([["../x.json", text]]), where), ArchiveError);
  assert.throws(
    () => planWrites(new Map(), new Map([["2025.json.bak", text]]), where),
    ArchiveError,
  );
  const twice = renderYearFiles([rec("a", "2026-01-01")]).get("2026.json") ?? "";
  assert.throws(
    () =>
      planWrites(
        new Map(),
        new Map([
          ["2025.json", text],
          ["2026.json", twice],
        ]),
        where,
      ),
    ArchiveError,
  );
  assert.throws(() => planWrites(new Map(), new Map([["2025.json", "["]]), where), ArchiveError);
});
