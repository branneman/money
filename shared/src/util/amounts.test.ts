import assert from "node:assert/strict";
import { test } from "node:test";

import { minorUnits, parseAmount } from "./amounts.ts";

test("amounts become integers in the smallest unit", () => {
  assert.equal(parseAmount("12.34", ".", "EUR"), 1234);
  assert.equal(parseAmount("12,34", ",", "EUR"), 1234);
  assert.equal(parseAmount("12", ".", "EUR"), 1200);
  assert.equal(parseAmount("12.3", ".", "EUR"), 1230);
  assert.equal(parseAmount("0.07", ".", "EUR"), 7);
});

// Some exports write a whole amount with its decimal mark and nothing after it.
test("a decimal mark with no digits after it ends a whole amount", () => {
  assert.equal(parseAmount("60,", ",", "CHF"), 6000);
  assert.equal(parseAmount("-60,", ",", "CHF"), -6000);
  assert.equal(parseAmount("12.", ".", "EUR"), 1200);
  assert.equal(parseAmount("3060000,", ",", "JPY"), 3060000);
  assert.equal(parseAmount("7,", ",", "KWD"), 7000);
});

test("a decimal mark alone, or twice, is still null", () => {
  for (const text of [",", "-,", "+,", "60,,", ",60", "60,5,"]) {
    assert.equal(parseAmount(text, ",", "EUR"), null, text);
  }
});

test("a leading sign is honoured", () => {
  assert.equal(parseAmount("-10,00", ",", "EUR"), -1000);
  assert.equal(parseAmount("+20,00", ",", "EUR"), 2000);
});

test("zero is zero, never negative zero", () => {
  assert.ok(Object.is(parseAmount("-0,00", ",", "EUR"), 0));
});

test("currencies have their own number of decimals", () => {
  assert.equal(minorUnits("EUR"), 2);
  assert.equal(minorUnits("JPY"), 0);
  assert.equal(minorUnits("KWD"), 3);
  assert.equal(parseAmount("1500", ".", "JPY"), 1500);
  assert.equal(parseAmount("1.234", ".", "KWD"), 1234);
});

test("a thousands separator is an error, never a different number", () => {
  assert.equal(parseAmount("1.234,56", ",", "EUR"), null);
  assert.equal(parseAmount("1,234.56", ".", "EUR"), null);
  assert.equal(parseAmount("1.234", ",", "EUR"), null);
  assert.equal(parseAmount("1 234,56", ",", "EUR"), null);
});

test("anything else that is not a plain number is null", () => {
  for (const text of ["", " ", "abc", "12,345", "1e3", "12.", ".5", "--1", "1.5"]) {
    assert.equal(
      parseAmount(text, text === "1.5" ? "." : ",", text === "1.5" ? "JPY" : "EUR"),
      null,
      text,
    );
  }
});

test("a number too large to hold exactly is null", () => {
  assert.equal(parseAmount("99999999999999999.99", ".", "EUR"), null);
});
