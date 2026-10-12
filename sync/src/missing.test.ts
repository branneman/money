import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord } from "@money/shared/testing";

import { missingIds, newlyMissing } from "./missing.ts";

const window = { strategy: "default", dateFrom: "2026-09-11", dateTo: "2026-10-11" } as const;
const on = (id: string, date: string) => anApiRecord({ id, date });

test("a stored record inside the window that the fetch did not return is missing", () => {
  const stored = [on("a", "2026-09-20"), on("b", "2026-09-21"), on("c", "2026-09-22")];
  assert.deepEqual(missingIds(stored, new Set(["b"]), window), ["a", "c"]);
});

test("the window includes its first and last day, and nothing outside them", () => {
  const stored = [
    on("before", "2026-09-10"),
    on("first", "2026-09-11"),
    on("last", "2026-10-11"),
    on("after", "2026-10-12"),
  ];
  assert.deepEqual(missingIds(stored, new Set(), window), ["first", "last"]);
});

test("nothing is missing when everything in the window came back", () => {
  const stored = [on("a", "2026-09-20")];
  assert.deepEqual(missingIds(stored, new Set(["a", "new"]), window), []);
});

test("only an id that was not already reported is newly missing", () => {
  assert.deepEqual(newlyMissing(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(newlyMissing(["a"], ["a"]), []);
  assert.deepEqual(newlyMissing([], ["a"]), []);
});
