import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { ArchiveError, checkRecord, identityOf } from "./record.ts";

test("identity is account, source and id", () => {
  assert.equal(identityOf(anApiRecord({ account: "bnka-joint", id: "7" })), "bnka-joint/api/7");
  assert.equal(identityOf(anImportRecord({ account: "bnka-card", id: "7" })), "bnka-card/import/7");
});

test("a well-formed record of either source passes", () => {
  assert.deepEqual(checkRecord(anApiRecord(), "here"), anApiRecord());
  assert.deepEqual(checkRecord(anImportRecord(), "here"), anImportRecord());
});

test("a record keeps its key order", () => {
  assert.deepEqual(Object.keys(anApiRecord()), [
    "account",
    "source",
    "id",
    "date",
    "first_seen",
    "revisions",
    "raw",
  ]);
  assert.deepEqual(Object.keys(anImportRecord()), [
    "account",
    "source",
    "id",
    "format",
    "date",
    "first_seen",
    "revisions",
    "raw",
  ]);
});

const broken: [string, unknown, RegExp][] = [
  ["not an object", [], /is not an object/],
  ["a bad account key", { ...anApiRecord(), account: "Bnka Joint" }, /account/],
  ["an unknown source", { ...anApiRecord(), source: "csv" }, /source/],
  ["an empty id", { ...anApiRecord(), id: "" }, /id/],
  ["an impossible date", { ...anApiRecord(), date: "2025-02-30" }, /date/],
  ["a first_seen that is not UTC", { ...anApiRecord(), first_seen: "2025-01-01" }, /first_seen/],
  ["revisions that are not a list", { ...anApiRecord(), revisions: {} }, /revisions/],
  [
    "a revision without raw",
    { ...anApiRecord(), revisions: [{ replaced_at: "2025-01-03T03:00:00Z" }] },
    /revisions/,
  ],
  ["a raw that is not an object", { ...anApiRecord(), raw: "x" }, /raw/],
  ["an import record without a format", { ...anImportRecord(), format: undefined }, /format/],
  ["an import cell that is not text", { ...anImportRecord(), raw: { Amount: 10 } }, /raw/],
];

for (const [name, value, message] of broken) {
  test(`a record with ${name} is rejected, naming where`, () => {
    assert.throws(
      () => checkRecord(value, "bnka-joint/api/2025.json, record 3"),
      (error: unknown) =>
        error instanceof ArchiveError &&
        message.test(error.message) &&
        error.message.startsWith("bnka-joint/api/2025.json, record 3"),
    );
  });
}
