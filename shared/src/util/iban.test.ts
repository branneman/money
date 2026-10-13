import assert from "node:assert/strict";
import { test } from "node:test";

import { plainIban } from "./iban.ts";

test("an IBAN is compared without its spaces and in capitals", () => {
  assert.equal(plainIban("nl00 bnka 0000 0000 01"), "NL00BNKA0000000001");
  assert.equal(plainIban(" NL00\tBNKA0000000001 "), "NL00BNKA0000000001");
  assert.equal(plainIban("NL00BNKA0000000001"), "NL00BNKA0000000001");
});
