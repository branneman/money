import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRaw, anApiRecord, anImportRaw, anIncoming } from "../../testing/factories.ts";
import { merge, MergeError } from "./merge.ts";
import type { Target } from "./merge.ts";

const API: Target = { account: "bnka-current", source: "api" };
const IMPORT: Target = { account: "bnka-current", source: "import", format: "example-export" };
const NOW = "2025-01-03T03:00:00Z";
const LATER = "2025-01-04T03:00:00Z";

test("a new transaction becomes a record, first seen now", () => {
  const result = merge([], [anIncoming()], API, NOW);
  assert.deepEqual(result.records, [anApiRecord({ first_seen: NOW })]);
  assert.deepEqual(result.added, ["bnka-current/api/20250102-10000001"]);
  assert.deepEqual(result.revised, []);
  assert.equal(result.unchanged, 0);
});

test("an import target stamps its format on the record", () => {
  const [record] = merge([], [anIncoming({ id: "1", raw: anImportRaw() })], IMPORT, NOW).records;
  assert.equal(record.source, "import");
  assert.equal(record.source === "import" && record.format, "example-export");
  assert.deepEqual(Object.keys(record).slice(0, 4), ["account", "source", "id", "format"]);
});

test("a known, identical transaction changes nothing", () => {
  const stored = merge([], [anIncoming()], API, NOW).records;
  const result = merge(stored, [anIncoming()], API, LATER);
  assert.deepEqual(result.records, stored);
  assert.deepEqual(result.added, []);
  assert.equal(result.unchanged, 1);
});

test("key order inside raw is not a change", () => {
  const stored = merge([], [anIncoming({ raw: { a: 1, b: 2 } })], API, NOW).records;
  const result = merge(stored, [anIncoming({ raw: { b: 2, a: 1 } })], API, LATER);
  assert.deepEqual(result.revised, []);
});

test("a changed transaction keeps its earlier version", () => {
  const before = anApiRaw({ remittance_information: ["Line one"] });
  const after = anApiRaw({ remittance_information: ["Line one", "Line two"] });
  const stored = merge([], [anIncoming({ raw: before })], API, NOW).records;
  const result = merge(stored, [anIncoming({ raw: after })], API, LATER);
  assert.deepEqual(result.records, [
    anApiRecord({
      first_seen: NOW,
      revisions: [{ replaced_at: LATER, raw: before }],
      raw: after,
    }),
  ]);
  assert.deepEqual(result.revised, ["bnka-current/api/20250102-10000001"]);
});

test("a revised booking date moves the record's date with it", () => {
  const stored = merge([], [anIncoming({ date: "2025-12-31" })], API, NOW).records;
  const result = merge(stored, [anIncoming({ date: "2026-01-01" })], API, LATER);
  assert.equal(result.records[0].date, "2026-01-01");
  assert.equal(result.records[0].revisions.length, 1);
});

test("two transactions alike in everything but id stay two", () => {
  const twins = [anIncoming({ id: "a" }), anIncoming({ id: "b" })];
  assert.equal(merge([], twins, API, NOW).records.length, 2);
});

test("the same transaction twice in one batch is stored once", () => {
  const result = merge([], [anIncoming(), anIncoming()], API, NOW);
  assert.equal(result.records.length, 1);
  assert.deepEqual(result.added, ["bnka-current/api/20250102-10000001"]);
});

test("one id with two different contents in one batch is an error", () => {
  const batch = [anIncoming(), anIncoming({ raw: anApiRaw({ status: "OTHR" }) })];
  assert.throws(() => merge([], batch, API, NOW), MergeError);
});

test("records come back sorted by date, then id", () => {
  const batch = [
    anIncoming({ id: "b", date: "2025-01-02" }),
    anIncoming({ id: "a", date: "2025-01-02" }),
    anIncoming({ id: "z", date: "2025-01-01" }),
  ];
  assert.deepEqual(
    merge([], batch, API, NOW).records.map((record) => record.id),
    ["z", "a", "b"],
  );
});

test("nothing stored is ever dropped", () => {
  const stored = merge([], [anIncoming({ id: "a" }), anIncoming({ id: "b" })], API, NOW).records;
  const result = merge(stored, [anIncoming({ id: "c" })], API, LATER);
  assert.deepEqual(result.records.map((record) => record.id).toSorted(), ["a", "b", "c"]);
});

test("an incoming transaction without an id or a real date is an error", () => {
  assert.throws(() => merge([], [anIncoming({ id: "" })], API, NOW), MergeError);
  assert.throws(() => merge([], [anIncoming({ date: "2025-02-30" })], API, NOW), MergeError);
});

test("stored records of another account or source are an error", () => {
  const foreign = [anApiRecord({ account: "bnka-joint" })];
  assert.throws(() => merge(foreign, [], API, NOW), MergeError);
  assert.throws(() => merge([anApiRecord()], [], IMPORT, NOW), MergeError);
});

test("the inputs are not modified", () => {
  const stored = merge([], [anIncoming()], API, NOW).records;
  const snapshot = structuredClone(stored);
  merge(stored, [anIncoming({ raw: anApiRaw({ status: "OTHR" }) })], API, LATER);
  assert.deepEqual(stored, snapshot);
});
