import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRecord } from "../../testing/factories.ts";
import { parseYearFile, renderYearFiles } from "./files.ts";
import { ArchiveError } from "./record.ts";

const WHERE = { account: "bnka-current", source: "api", year: "2025" } as const;
const a = anApiRecord({ id: "a", date: "2025-01-02" });
const b = anApiRecord({ id: "b", date: "2025-01-02" });
const next = anApiRecord({ id: "c", date: "2026-01-01" });

test("records are split by the year of their date", () => {
  const files = renderYearFiles([next, a]);
  assert.deepEqual([...files.keys()].toSorted(), ["2025.json", "2026.json"]);
});

test("a file is sorted by date then id, whatever order the records came in", () => {
  const early = anApiRecord({ id: "z", date: "2025-01-01" });
  assert.equal(
    renderYearFiles([b, early, a]).get("2025.json"),
    renderYearFiles([early, a, b]).get("2025.json"),
  );
  const ids = parseYearFile(renderYearFiles([b, early, a]).get("2025.json") ?? "", WHERE).map(
    (r) => r.id,
  );
  assert.deepEqual(ids, ["z", "a", "b"]);
});

test("the text is two-space JSON with a trailing newline", () => {
  const text = renderYearFiles([a]).get("2025.json") ?? "";
  assert.ok(text.startsWith('[\n  {\n    "account": "bnka-current",\n    "source": "api",'));
  assert.ok(text.endsWith("]\n"));
  assert.ok(!text.endsWith("\n\n"));
});

test("rendering and parsing round-trips without loss, and renders the same bytes again", () => {
  const text = renderYearFiles([a, b]).get("2025.json") ?? "";
  const parsed = parseYearFile(text, WHERE);
  assert.deepEqual(parsed, [a, b]);
  assert.equal(renderYearFiles(parsed).get("2025.json"), text);
});

test("no records gives no files", () => {
  assert.equal(renderYearFiles([]).size, 0);
});

test("an empty array is a valid, empty year file", () => {
  assert.deepEqual(parseYearFile("[]\n", WHERE), []);
});

const rejected: [string, string, RegExp][] = [
  ["text that is not JSON", "{", /is not valid JSON/],
  ["an empty file", "", /is not valid JSON/],
  ["JSON that is not a list", "{}", /is not a list/],
  ["a record from another year", JSON.stringify([next]), /belongs in 2026/],
  [
    "a record of another account",
    JSON.stringify([anApiRecord({ account: "bnka-joint" })]),
    /another account/,
  ],
  [
    "a record of another source",
    JSON.stringify([{ ...a, source: "import", format: "x", raw: {} }]),
    /another source/,
  ],
  ["records out of order", JSON.stringify([b, a]), /out of order/],
  ["the same id twice", JSON.stringify([a, a]), /out of order|twice/],
  ["a malformed record", JSON.stringify([{ ...a, date: "soon" }]), /record 1: date/],
];

for (const [name, text, message] of rejected) {
  test(`a file with ${name} is rejected, naming the file`, () => {
    assert.throws(
      () => parseYearFile(text, WHERE),
      (error: unknown) =>
        error instanceof ArchiveError &&
        error.message.startsWith("bnka-current/api/2025.json") &&
        message.test(error.message),
    );
  });
}

test("a byte order mark is not accepted as JSON", () => {
  assert.throws(() => parseYearFile("﻿[]\n", WHERE), ArchiveError);
});
