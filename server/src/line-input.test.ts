import assert from "node:assert/strict";
import { test } from "node:test";

import { splitInput } from "./line-input.ts";

test("text without a line break is kept for the next chunk", () => {
  assert.deepEqual(splitInput("", "abc"), {
    line: null,
    rest: "abc",
    aborted: false,
    skipLineFeed: false,
  });
  assert.deepEqual(splitInput("abc", "def"), {
    line: null,
    rest: "abcdef",
    aborted: false,
    skipLineFeed: false,
  });
});

test("a line break ends the line and what follows it is kept", () => {
  assert.deepEqual(splitInput("ab", "c\nsecond\n"), {
    line: "abc",
    rest: "second\n",
    aborted: false,
    skipLineFeed: false,
  });
});

test("a carriage return and line feed are one break", () => {
  assert.deepEqual(splitInput("", "one\r\ntwo"), {
    line: "one",
    rest: "two",
    aborted: false,
    skipLineFeed: false,
  });
});

test("backspace removes the last typed character, and does nothing on an empty line", () => {
  assert.deepEqual(splitInput("", "abx\u007f\r"), {
    line: "ab",
    rest: "",
    aborted: false,
    skipLineFeed: true,
  });
  assert.deepEqual(splitInput("", "\u007f\u007fa\r"), {
    line: "a",
    rest: "",
    aborted: false,
    skipLineFeed: true,
  });
});

test("Ctrl-C and Ctrl-D abort", () => {
  assert.equal(splitInput("ab", "c\u0003").aborted, true);
  assert.equal(splitInput("", "\u0004").aborted, true);
});

test("backspace removes a whole character, even one outside the basic plane", () => {
  assert.deepEqual(splitInput("", "a\u{1F600}\u007f\r"), {
    line: "a",
    rest: "",
    aborted: false,
    skipLineFeed: true,
  });
  assert.deepEqual(splitInput("a\u{1F600}", "\u007fb\r"), {
    line: "ab",
    rest: "",
    aborted: false,
    skipLineFeed: true,
  });
});

test("a carriage return and line feed split across two chunks are one break", () => {
  const first = splitInput("", "one\r");
  assert.equal(first.line, "one");
  assert.equal(first.skipLineFeed, true);
  const second = splitInput(first.rest, "\ntwo\r", first.skipLineFeed);
  assert.equal(second.line, "two");
  assert.equal(second.skipLineFeed, true);
});

test("a line feed after a lone line feed is a second, empty line", () => {
  const first = splitInput("", "one\n");
  assert.equal(first.skipLineFeed, false);
  assert.equal(splitInput(first.rest, "\n", first.skipLineFeed).line, "");
});
