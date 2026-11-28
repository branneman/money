import assert from "node:assert/strict";
import { test } from "node:test";

import { splitInput } from "./line-input.ts";

test("text without a line break is kept for the next chunk", () => {
  assert.deepEqual(splitInput("", "abc"), { line: null, rest: "abc", aborted: false });
  assert.deepEqual(splitInput("abc", "def"), { line: null, rest: "abcdef", aborted: false });
});

test("a line break ends the line and what follows it is kept", () => {
  assert.deepEqual(splitInput("ab", "c\nsecond\n"), {
    line: "abc",
    rest: "second\n",
    aborted: false,
  });
});

test("a carriage return and line feed are one break", () => {
  assert.deepEqual(splitInput("", "one\r\ntwo"), { line: "one", rest: "two", aborted: false });
});

test("backspace removes the last typed character, and does nothing on an empty line", () => {
  assert.deepEqual(splitInput("", "abx\u007f\r"), { line: "ab", rest: "", aborted: false });
  assert.deepEqual(splitInput("", "\u007f\u007fa\r"), { line: "a", rest: "", aborted: false });
});

test("Ctrl-C and Ctrl-D abort", () => {
  assert.equal(splitInput("ab", "c\u0003").aborted, true);
  assert.equal(splitInput("", "\u0004").aborted, true);
});
