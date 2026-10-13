import assert from "node:assert/strict";
import { test } from "node:test";

import { decode } from "./decode.ts";
import { ImportError, reject } from "./error.ts";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

test("each encoding decodes known bytes to the right text", () => {
  // "é" and "€" in each encoding.
  assert.equal(decode(bytes(0x61, 0xc3, 0xa9, 0xe2, 0x82, 0xac), "utf-8"), "aé€");
  assert.equal(decode(bytes(0x61, 0xe9, 0x80), "windows-1252"), "aé€");
  assert.equal(decode(bytes(0x61, 0xe9, 0xa4), "iso-8859-15"), "aé€");
});

test("a plain ASCII file reads the same under every encoding", () => {
  const text = "Booked;Amount\r\n2025-01-02;-1,00\r\n";
  for (const encoding of ["utf-8", "windows-1252", "iso-8859-15"] as const) {
    assert.equal(decode(utf8(text), encoding), text);
  }
});

test("a byte order mark on a utf-8 file is dropped", () => {
  assert.equal(decode(bytes(0xef, 0xbb, 0xbf, 0x61), "utf-8"), "a");
});

test("an empty file decodes to nothing", () => {
  assert.equal(decode(bytes(), "utf-8"), "");
});

const refused: [string, Uint8Array, "utf-8" | "windows-1252" | "iso-8859-15", RegExp][] = [
  [
    "bytes that are not UTF-8, declared utf-8",
    bytes(0x61, 0xe9, 0x62),
    "utf-8",
    /is not valid UTF-8/,
  ],
  [
    "multi-byte UTF-8 declared windows-1252",
    utf8("café"),
    "windows-1252",
    /is valid UTF-8 with characters beyond ASCII, but its format declares windows-1252/,
  ],
  [
    "multi-byte UTF-8 declared iso-8859-15",
    utf8("café"),
    "iso-8859-15",
    /but its format declares iso-8859-15/,
  ],
  [
    "a UTF-8 byte order mark declared single-byte",
    bytes(0xef, 0xbb, 0xbf, 0x61),
    "windows-1252",
    /starts with a UTF-8 byte order mark, but its format declares windows-1252/,
  ],
  ["a UTF-16 byte order mark, little endian", bytes(0xff, 0xfe, 0x61, 0x00), "utf-8", /UTF-16/],
  ["a UTF-16 byte order mark, big endian", bytes(0xfe, 0xff, 0x00, 0x61), "windows-1252", /UTF-16/],
  ["a control character", bytes(0x61, 0x00, 0x62), "utf-8", /control character/],
  ["an escape character", bytes(0x61, 0x1b, 0x62), "windows-1252", /control character/],
  [
    "a windows-1252 euro sign read as iso-8859-15",
    bytes(0x61, 0x80),
    "iso-8859-15",
    /control character/,
  ],
  ["a byte windows-1252 gives no meaning", bytes(0x61, 0x81), "windows-1252", /control character/],
];

for (const [label, input, encoding, pattern] of refused) {
  test(`refused: ${label}`, () => {
    assert.throws(
      () => decode(input, encoding),
      (error: unknown) => error instanceof ImportError && pattern.test(error.message),
    );
  });
}

test("tab, carriage return and line feed are not control characters here", () => {
  assert.equal(decode(utf8("a\tb\r\nc\n"), "utf-8"), "a\tb\r\nc\n");
});

test("reject joins the problems, and stops at twenty", () => {
  assert.equal(reject(["one", "two"]).message, "one\ntwo");
  const many = Array.from({ length: 23 }, (_, index) => `problem ${index + 1}`);
  const lines = reject(many).message.split("\n");
  assert.equal(lines.length, 21);
  assert.equal(lines[19], "problem 20");
  assert.equal(lines[20], "and 3 more");
});
