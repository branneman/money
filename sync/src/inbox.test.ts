import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { SyncError } from "./errors.ts";
import { completeRun, listRuns, removeRun, writePage } from "./inbox.ts";
import type { Marker } from "./inbox.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-inbox-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ACCOUNT = "bnka-current";
const RUN = "20261011T030000Z";
const runDir = (run = RUN): string => join(dir, ".inbox", ACCOUNT, run);
const marker = (pages: number): Marker => ({
  started: "2026-10-11T03:00:00Z",
  window: { strategy: "default", dateFrom: "2026-09-11", dateTo: "2026-10-11" },
  pages,
});
const refused = async (message: string): Promise<void> => {
  await assert.rejects(listRuns(dir, ACCOUNT), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.equal(error.message, message);
    return true;
  });
};

test("an account with no inbox has no runs", async () => {
  assert.deepEqual(await listRuns(dir, ACCOUNT), []);
});

test("a page is stored exactly as received, and no temporary file is left", async () => {
  const text = '{ "transactions": [ ],\n  "continuation_key": null }';
  await writePage(dir, ACCOUNT, RUN, 1, text);
  assert.equal(await readFile(join(runDir(), "1.json"), "utf8"), text);
  assert.deepEqual(await readdir(runDir()), ["1.json"]);
});

test("a run without its marker is incomplete, and still gives its pages in order", async () => {
  for (const number of [2, 10, 1, 3, 4, 5, 6, 7, 8, 9]) {
    await writePage(dir, ACCOUNT, RUN, number, `page ${number}`);
  }
  const [run] = await listRuns(dir, ACCOUNT);
  assert.equal(run.name, RUN);
  assert.equal(run.marker, null);
  assert.deepEqual(
    run.pages,
    Array.from({ length: 10 }, (_, index) => `page ${index + 1}`),
  );
});

test("a completed run carries its marker", async () => {
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await completeRun(dir, ACCOUNT, RUN, marker(1));
  assert.deepEqual(await listRuns(dir, ACCOUNT), [
    { name: RUN, marker: marker(1), pages: ["one"] },
  ]);
});

test("a backfill's marker has no dates", async () => {
  const longest: Marker = {
    started: "2026-10-11T03:00:00Z",
    window: { strategy: "longest" },
    pages: 1,
  };
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await completeRun(dir, ACCOUNT, RUN, longest);
  assert.deepEqual((await listRuns(dir, ACCOUNT))[0].marker, longest);
});

test("runs come back oldest first", async () => {
  for (const run of ["20261011T030000Z", "20261009T030000Z", "20261010T030000Z"]) {
    await writePage(dir, ACCOUNT, run, 1, run);
  }
  assert.deepEqual(
    (await listRuns(dir, ACCOUNT)).map((run) => run.name),
    ["20261009T030000Z", "20261010T030000Z", "20261011T030000Z"],
  );
});

test("a run that died before its first page is an empty, incomplete run", async () => {
  await mkdir(runDir(), { recursive: true });
  assert.deepEqual(await listRuns(dir, ACCOUNT), [{ name: RUN, marker: null, pages: [] }]);
});

test("a temporary file left by a crash is not a page", async () => {
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await writeFile(join(runDir(), ".2.json.tmp"), "half a pa");
  assert.deepEqual((await listRuns(dir, ACCOUNT))[0].pages, ["one"]);
});

test("removing a run leaves the others", async () => {
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await writePage(dir, ACCOUNT, "20261012T030000Z", 1, "two");
  await removeRun(dir, ACCOUNT, RUN);
  assert.deepEqual(
    (await listRuns(dir, ACCOUNT)).map((run) => run.name),
    ["20261012T030000Z"],
  );
});

test("anything in the inbox that is not a run, a page or a marker is reported", async () => {
  await mkdir(join(dir, ".inbox", ACCOUNT, "not-a-run"), { recursive: true });
  await refused("the inbox of bnka-current holds something that is not a run");
  await rm(join(dir, ".inbox", ACCOUNT, "not-a-run"), { recursive: true });

  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await writeFile(join(runDir(), "notes.txt"), "x");
  await refused("bnka-current, run 20261011T030000Z holds something that is not a page");
});

test("a run with a page absent from the middle is reported", async () => {
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await writePage(dir, ACCOUNT, RUN, 3, "three");
  await refused("bnka-current, run 20261011T030000Z: page 2 is absent");
});

test("a marker that disagrees with the pages, or is not a marker, is reported", async () => {
  await writePage(dir, ACCOUNT, RUN, 1, "one");
  await completeRun(dir, ACCOUNT, RUN, marker(2));
  await refused("bnka-current, run 20261011T030000Z: the marker counts 2 pages and 1 are there");

  for (const text of [
    "not json",
    "[]",
    '{"started":"yesterday","window":{"strategy":"longest"},"pages":1}',
    '{"started":"2026-10-11T03:00:00Z","window":{"strategy":"default","dateFrom":"2026-09-11"},"pages":1}',
    '{"started":"2026-10-11T03:00:00Z","window":{"strategy":"longest"},"pages":0}',
  ]) {
    await writeFile(join(runDir(), "complete.json"), text);
    await refused("bnka-current, run 20261011T030000Z: the marker is not one the sync wrote");
  }
});
