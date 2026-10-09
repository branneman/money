import assert from "node:assert/strict";
import { test } from "node:test";

import { aFormat, anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { apiStarts, view, visibleRecords } from "./view.ts";

const FORMATS = { "example-export": aFormat() };
const imported = (id: string, date: string, account = "bnka-current") =>
  anImportRecord({ id, date, account });
const fetched = (id: string, date: string, account = "bnka-current") =>
  anApiRecord({ id, date, account });

test("an account's API start is the earliest date among its API records", () => {
  const starts = apiStarts([
    fetched("b", "2025-03-01"),
    fetched("a", "2025-01-10"),
    imported("x", "2021-01-01"),
  ]);
  assert.deepEqual([...starts], [["bnka-current", "2025-01-10"]]);
});

test("import records on or after the API start are left out", () => {
  const records = [
    imported("old", "2025-01-09"),
    imported("same-day", "2025-01-10"),
    imported("later", "2025-02-01"),
    fetched("first", "2025-01-10"),
  ];
  assert.deepEqual(
    visibleRecords(records)
      .map((record) => record.id)
      .toSorted(),
    ["first", "old"],
  );
});

test("an account with no API records keeps every import record", () => {
  const records = [
    imported("a", "2021-01-01", "bnka-card"),
    imported("b", "2026-01-01", "bnka-card"),
  ];
  assert.equal(visibleRecords(records).length, 2);
});

test("one account's API start does not hide another account's imports", () => {
  const records = [
    fetched("f", "2025-01-10", "bnka-current"),
    imported("i", "2026-01-01", "bnka-card"),
  ];
  assert.equal(visibleRecords(records).length, 2);
});

test("the result does not depend on the order of the records", () => {
  const records = [
    imported("old", "2025-01-09"),
    imported("later", "2025-02-01"),
    fetched("first", "2025-01-10"),
  ];
  assert.deepEqual(view(records.toReversed(), FORMATS), view(records, FORMATS));
});

test("the view is sorted by date, account, source and id", () => {
  const records = [
    fetched("b", "2025-01-02", "bnka-joint"),
    fetched("a", "2025-01-02", "bnka-joint"),
    imported("z", "2025-01-02", "bnka-card"),
    fetched("y", "2025-01-01", "bnka-joint"),
  ];
  assert.deepEqual(
    view(records, FORMATS).map((item) => `${item.date} ${item.account} ${item.id}`),
    [
      "2025-01-01 bnka-joint y",
      "2025-01-02 bnka-card z",
      "2025-01-02 bnka-joint a",
      "2025-01-02 bnka-joint b",
    ],
  );
});

test("nothing is removed from the input", () => {
  const records = [imported("later", "2025-02-01"), fetched("first", "2025-01-10")];
  visibleRecords(records);
  assert.equal(records.length, 2);
});
