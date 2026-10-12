import { addDays, dateOf } from "./time.ts";

export type DatedWindow = { strategy: "default"; dateFrom: string; dateTo: string };
export type Window = { strategy: "longest" } | DatedWindow;

// What to ask a bank for. An account with no recorded success is asked for the longest
// period the bank will give: that is a first fetch, a backfill that died, or lost state.
// Otherwise the window is anchored on the last success, so missed nights catch up on their
// own, and reaches back further by the lookback, because banks book late. Both times are
// UTC timestamps, and the dates sent are UTC dates.
export const fetchWindow = (
  lastSuccess: string | undefined,
  now: string,
  lookbackDays: number,
): Window =>
  lastSuccess === undefined
    ? { strategy: "longest" }
    : {
        strategy: "default",
        dateFrom: addDays(dateOf(lastSuccess), -lookbackDays),
        dateTo: dateOf(now),
      };
