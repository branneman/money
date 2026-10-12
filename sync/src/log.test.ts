import assert from "node:assert/strict";
import { test } from "node:test";

import { makeLog } from "./log.ts";

test("a line is the event followed by key=value pairs", () => {
  const lines: string[] = [];
  const log = makeLog((line) => lines.push(line));
  log("merged", { account: "bnka-current", run: "20261011T030000Z", added: 3, from: "2026-09-11" });
  log("done");
  assert.deepEqual(lines, [
    "merged account=bnka-current run=20261011T030000Z added=3 from=2026-09-11",
    "done",
  ]);
});

test("a value that is not a key, a date, a count or a code is refused, without being printed", () => {
  const lines: string[] = [];
  const log = makeLog((line) => lines.push(line));
  assert.throws(
    () => log("merged", { account: "Recognisable Person" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "log field account of merged holds something that may not be logged",
  );
  assert.deepEqual(lines, []);
});
