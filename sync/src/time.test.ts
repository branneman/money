import assert from "node:assert/strict";
import { test } from "node:test";

import { addDays, dateOf, runNameOf, timestampOf } from "./time.ts";

test("a timestamp is UTC in whole seconds", () => {
  assert.equal(timestampOf(new Date("2026-10-11T03:00:00.987Z")), "2026-10-11T03:00:00Z");
});

// The tests run in Europe/Amsterdam. Half past midnight there on New Year's Day is still
// the old year in UTC, which is the date the bank means.
test("the date of an instant is its UTC date, on both sides of midnight", () => {
  assert.equal(dateOf(timestampOf(new Date("2026-01-01T00:30:00+01:00"))), "2025-12-31");
  assert.equal(dateOf(timestampOf(new Date("2026-01-01T01:30:00+01:00"))), "2026-01-01");
  assert.equal(dateOf(timestampOf(new Date("2026-07-01T01:30:00+02:00"))), "2026-06-30");
});

test("days are added across months, years and leap days", () => {
  assert.equal(addDays("2026-01-10", -30), "2025-12-11");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.equal(addDays("2026-03-29", 1), "2026-03-30");
  assert.equal(addDays("2026-10-11", 0), "2026-10-11");
});

test("a run is named after its start, in a form that sorts and is a safe file name", () => {
  assert.equal(runNameOf("2026-10-11T03:00:00Z"), "20261011T030000Z");
});
