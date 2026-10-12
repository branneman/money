import assert from "node:assert/strict";
import { test } from "node:test";

import { timestampOf } from "./time.ts";
import { fetchWindow } from "./window.ts";

test("an account that has never been fetched in full asks for the longest period", () => {
  assert.deepEqual(fetchWindow(undefined, "2026-10-11T03:00:00Z", 30), { strategy: "longest" });
});

test("a normal night reaches back from the last success by the lookback", () => {
  assert.deepEqual(fetchWindow("2026-10-10T03:00:00Z", "2026-10-11T03:00:00Z", 30), {
    strategy: "default",
    dateFrom: "2026-09-10",
    dateTo: "2026-10-11",
  });
});

test("missed nights are caught up, because the window starts from the last success", () => {
  assert.deepEqual(fetchWindow("2026-09-01T03:00:00Z", "2026-10-11T03:00:00Z", 30), {
    strategy: "default",
    dateFrom: "2026-08-02",
    dateTo: "2026-10-11",
  });
});

test("a window crosses a year boundary", () => {
  assert.deepEqual(fetchWindow("2026-01-05T03:00:00Z", "2026-01-06T03:00:00Z", 30), {
    strategy: "default",
    dateFrom: "2025-12-06",
    dateTo: "2026-01-06",
  });
});

test("a lookback of nothing still includes the day of the last success", () => {
  assert.deepEqual(fetchWindow("2026-10-10T03:00:00Z", "2026-10-11T03:00:00Z", 0), {
    strategy: "default",
    dateFrom: "2026-10-10",
    dateTo: "2026-10-11",
  });
});

// The tests run in Europe/Amsterdam. A run at half past midnight there is still yesterday
// in UTC, and the bank's dates are UTC dates.
test("the window's dates are UTC dates, whatever the local date is", () => {
  const now = timestampOf(new Date("2026-01-01T00:30:00+01:00"));
  const last = timestampOf(new Date("2025-12-31T00:30:00+01:00"));
  assert.deepEqual(fetchWindow(last, now, 1), {
    strategy: "default",
    dateFrom: "2025-12-29",
    dateTo: "2025-12-31",
  });
});
