import assert from "node:assert/strict";
import { test } from "node:test";

import { isIsoDate, isTimestamp, parseDate } from "./dates.ts";

test("a real calendar date is accepted", () => {
  assert.ok(isIsoDate("2024-02-29"));
});

test("a date that does not exist is rejected", () => {
  assert.ok(!isIsoDate("2025-02-29"));
  assert.ok(!isIsoDate("2025-13-01"));
  assert.ok(!isIsoDate("2025-1-1"));
  assert.ok(!isIsoDate("2025-01-01T00:00:00Z"));
});

test("only UTC timestamps are accepted", () => {
  assert.ok(isTimestamp("2026-10-07T03:00:00Z"));
  assert.ok(isTimestamp("2026-10-07T03:00:00.123Z"));
  assert.ok(!isTimestamp("2026-10-07T03:00:00+02:00"));
  assert.ok(!isTimestamp("2026-10-07"));
});

test("a time of day that does not exist is rejected", () => {
  assert.ok(!isTimestamp("2026-10-07T24:00:00Z"));
  assert.ok(!isTimestamp("2026-10-07T25:00:00Z"));
  assert.ok(!isTimestamp("2026-10-07T99:99:99Z"));
  assert.ok(!isTimestamp("2026-10-07T03:60:00Z"));
  assert.ok(!isTimestamp("2026-10-07T03:00:60Z"));
  assert.ok(isTimestamp("2026-10-07T23:59:59Z"));
  assert.ok(isTimestamp("2026-10-07T23:59:59.999Z"));
});

test("each supported notation parses to an ISO date", () => {
  assert.equal(parseDate("2025-12-31", "YYYY-MM-DD"), "2025-12-31");
  assert.equal(parseDate("31-12-2025", "DD-MM-YYYY"), "2025-12-31");
  assert.equal(parseDate("31/12/2025", "DD/MM/YYYY"), "2025-12-31");
  assert.equal(parseDate("20251231", "YYYYMMDD"), "2025-12-31");
});

test("text in another notation, or an impossible date, is null", () => {
  assert.equal(parseDate("31-12-2025", "YYYY-MM-DD"), null);
  assert.equal(parseDate("30-02-2025", "DD-MM-YYYY"), null);
  assert.equal(parseDate("", "YYYYMMDD"), null);
});
