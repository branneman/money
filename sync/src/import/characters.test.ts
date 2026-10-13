import assert from "node:assert/strict";
import { test } from "node:test";

import { describeCharacter, nonAscii } from "./characters.ts";

test("an ASCII text has none", () => {
  assert.deepEqual(nonAscii("Booked;Amount\r\n2025-01-02;-1,00\r\n"), []);
});

test("each distinct character is counted, in code point order", () => {
  assert.deepEqual(nonAscii("€ café, crème brûlée €"), [
    { character: "è", count: 1 },
    { character: "é", count: 2 },
    { character: "û", count: 1 },
    { character: "€", count: 2 },
  ]);
});

test("a character beyond the basic plane is one character", () => {
  assert.deepEqual(nonAscii("a😀b😀"), [{ character: "😀", count: 2 }]);
});

test("a line shows the code point, the character and the count", () => {
  assert.equal(describeCharacter({ character: "é", count: 14 }), "  U+00E9 é 14");
  assert.equal(describeCharacter({ character: "😀", count: 1 }), "  U+1F600 😀 1");
});
