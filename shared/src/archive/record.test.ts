import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRaw, anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { ArchiveError, checkRecord, compareRecords, identityOf } from "./record.ts";

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
  [
    "a first_seen with fractional seconds",
    { ...anApiRecord(), first_seen: "2025-01-03T03:00:00.123Z" },
    /first_seen/,
  ],
  ["revisions that are not a list", { ...anApiRecord(), revisions: {} }, /revisions/],
  [
    "a revision without raw",
    { ...anApiRecord(), revisions: [{ replaced_at: "2025-01-03T03:00:00Z" }] },
    /revisions/,
  ],
  [
    "a revision whose replaced_at is not a UTC time",
    {
      ...anApiRecord(),
      revisions: [{ replaced_at: "2025-01-03T25:00:00Z", raw: anApiRaw() }],
    },
    /revisions/,
  ],
  [
    "an import revision with a cell that is not text",
    {
      ...anImportRecord(),
      revisions: [{ replaced_at: "2025-01-03T03:00:00Z", raw: { Amount: 10 } }],
    },
    /revisions/,
  ],
  ["a raw that is not an object", { ...anApiRecord(), raw: "x" }, /raw/],
  ["an import record without a format", { ...anImportRecord(), format: undefined }, /format/],
  [
    "an import record whose format is not a key",
    { ...anImportRecord(), format: "Example Export" },
    /format is not a valid key/,
  ],
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

test("records order by date, then by id", () => {
  const early = anApiRecord({ id: "z", date: "2025-01-01" });
  const a = anApiRecord({ id: "a", date: "2025-01-02" });
  const b = anApiRecord({ id: "b", date: "2025-01-02" });
  assert.deepEqual(
    [b, a, early].toSorted(compareRecords).map((record) => record.id),
    ["z", "a", "b"],
  );
  assert.equal(compareRecords(a, a), 0);
});

test("an archive error carries its class name", () => {
  assert.equal(new ArchiveError("x").name, "ArchiveError");
});
