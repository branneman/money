import assert from "node:assert/strict";
import { test } from "node:test";

import { deepEqual } from "./equal.ts";

test("equal values are equal whatever their key order", () => {
  assert.ok(deepEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
});

test("differences at any depth are seen", () => {
  assert.ok(!deepEqual({ a: [1, 2] }, { a: [1, 3] }));
  assert.ok(!deepEqual({ a: 1 }, { a: 1, b: undefined }));
  assert.ok(!deepEqual([1], { 0: 1 }));
  assert.ok(!deepEqual(null, {}));
  assert.ok(!deepEqual("1", 1));
});
