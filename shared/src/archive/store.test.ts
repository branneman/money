import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { anApiRecord, anImportRecord } from "../../testing/factories.ts";
import { renderYearFiles } from "./files.ts";
import { ArchiveError } from "./record.ts";
import type { Source } from "./record.ts";
import { readAccountSource, readArchive, writeYearFiles } from "./store.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const a = anApiRecord({ id: "a", date: "2025-06-01" });
const b = anApiRecord({ id: "b", date: "2026-01-01" });
const write = (records: Parameters<typeof renderYearFiles>[0]) =>
  writeYearFiles(dir, "bnka-current", "api", renderYearFiles(records));

test("an archive that does not exist yet reads as empty", async () => {
  assert.deepEqual(await readArchive(join(dir, "nothing-here")), []);
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), []);
});

test("what is written can be read back", async () => {
  assert.deepEqual(await write([a, b]), { written: ["2025.json", "2026.json"], removed: [] });
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [a, b]);
});

test("the whole archive is read across accounts and sources", async () => {
  await write([a]);
  const imported = anImportRecord({ account: "bnka-card", date: "2025-06-01" });
  await writeYearFiles(dir, "bnka-card", "import", renderYearFiles([imported]));
  assert.equal((await readArchive(dir)).length, 2);
});

test("a file whose text has not changed is left untouched", async () => {
  await write([a]);
  const path = join(dir, "bnka-current", "api", "2025.json");
  const before = (await stat(path)).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(await write([a]), { written: [], removed: [] });
  assert.equal((await stat(path)).mtimeMs, before);
});

test("only the files that changed are rewritten", async () => {
  await write([a, b]);
  const result = await write([a, b, anApiRecord({ id: "c", date: "2026-02-01" })]);
  assert.deepEqual(result, { written: ["2026.json"], removed: [] });
});

test("no temporary file is left behind", async () => {
  await write([a]);
  assert.deepEqual(await readdir(join(dir, "bnka-current", "api")), ["2025.json"]);
});

test("a record that moved to another year leaves no empty year behind", async () => {
  await write([a]);
  const moved = { ...a, date: "2026-06-01" };
  assert.deepEqual(await write([moved]), { written: ["2026.json"], removed: ["2025.json"] });
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [moved]);
});

test("dot-prefixed names are skipped at every level", async () => {
  await write([a]);
  await mkdir(join(dir, ".inbox", "bnka-current"), { recursive: true });
  await writeFile(join(dir, ".DS_Store"), "x");
  await writeFile(join(dir, "bnka-current", ".DS_Store"), "x");
  await writeFile(join(dir, "bnka-current", "api", ".2025.json.tmp"), "half a fi");
  assert.deepEqual(await readArchive(dir), [a]);
});

// Each stray is reported by what it is, never by its name: a name that failed its pattern
// may be anything.
const strays: [string, (root: string) => Promise<unknown>, string, string][] = [
  [
    "a directory that is not an account key",
    (root) => mkdir(join(root, "Not A Key")),
    "a directory in the archive is not an account key",
    "Not A Key",
  ],
  [
    "a file where accounts belong",
    (root) => writeFile(join(root, "notes.txt"), "x"),
    "the archive holds a file where account directories belong",
    "notes",
  ],
  [
    "an unknown source directory",
    (root) => mkdir(join(root, "bnka-current", "csv"), { recursive: true }),
    "bnka-current holds something that is not api or import",
    "csv",
  ],
  [
    "a file that is not a year file",
    (root) => writeFile(join(root, "bnka-current", "api", "2025.json.bak"), "x"),
    "bnka-current/api holds something that is not a year file",
    "bak",
  ],
];

for (const [name, make, message, offending] of strays) {
  test(`${name} is reported, not ignored, and not repeated`, async () => {
    await write([a]);
    await make(dir);
    await assert.rejects(readArchive(dir), (error: unknown) => {
      assert.ok(error instanceof ArchiveError);
      assert.equal(error.message, message);
      assert.ok(!error.message.includes(offending));
      return true;
    });
  });
}

test("a corrupt year file stops the read", async () => {
  await write([a]);
  await writeFile(join(dir, "bnka-current", "api", "2025.json"), "[");
  await assert.rejects(readArchive(dir), ArchiveError);
});

test("one id in two year files is reported", async () => {
  await write([a]);
  const copy = renderYearFiles([{ ...a, date: "2026-06-01" }]).get("2026.json") ?? "";
  await writeFile(join(dir, "bnka-current", "api", "2026.json"), copy);
  await assert.rejects(
    readArchive(dir),
    /bnka-current\/api\/a is stored in more than one year file/,
  );
});

test("written text is exactly the rendered text", async () => {
  await write([a]);
  const text = await readFile(join(dir, "bnka-current", "api", "2025.json"), "utf8");
  assert.equal(text, renderYearFiles([a]).get("2025.json"));
});

test("an account that is not a key is refused, and nothing is written", async () => {
  // The data directory sits two levels below a fresh parent, so "../.." would land in the
  // parent, and the parent's whole listing shows whether anything was written.
  const parent = await mkdtemp(join(tmpdir(), "money-store-parent-"));
  try {
    const dataDir = join(parent, "one", "two");
    await mkdir(dataDir, { recursive: true });
    const before = (await readdir(parent, { recursive: true })).toSorted();
    const refused = (error: unknown): boolean => {
      assert.ok(error instanceof ArchiveError);
      assert.equal(error.message, "the account is not a valid key");
      assert.ok(!error.message.includes(".."));
      return true;
    };
    await assert.rejects(writeYearFiles(dataDir, "../..", "api", renderYearFiles([a])), refused);
    await assert.rejects(readAccountSource(dataDir, "../..", "api"), refused);
    assert.deepEqual((await readdir(parent, { recursive: true })).toSorted(), before);
    assert.deepEqual(before, ["one", join("one", "two")]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a source that is neither api nor import is refused without repeating it", async () => {
  const refused = (error: unknown): boolean => {
    assert.ok(error instanceof ArchiveError);
    assert.equal(error.message, "the source is neither api nor import");
    assert.ok(!error.message.includes("csv"));
    return true;
  };
  await assert.rejects(readAccountSource(dir, "bnka-current", "csv" as Source), refused);
  await assert.rejects(
    writeYearFiles(dir, "bnka-current", "csv" as Source, renderYearFiles([a])),
    refused,
  );
  assert.deepEqual(await readdir(dir), []);
});

test("no directory is created when there is nothing to write", async () => {
  await write([a]);
  const before = (await readdir(dir, { recursive: true })).toSorted();
  assert.deepEqual(await write([a]), { written: [], removed: [] });
  assert.deepEqual((await readdir(dir, { recursive: true })).toSorted(), before);

  const empty = await writeYearFiles(dir, "bnka-joint", "api", new Map());
  assert.deepEqual(empty, { written: [], removed: [] });
  assert.deepEqual((await readdir(dir, { recursive: true })).toSorted(), before);
});

test("a file name that is not a year file is refused, and nothing is written", async () => {
  const text = renderYearFiles([a]).get("2025.json") ?? "";
  await assert.rejects(
    writeYearFiles(dir, "bnka-current", "api", new Map([["../x.json", text]])),
    ArchiveError,
  );
  assert.deepEqual(await readdir(dir), []);
  assert.equal((await readdir(dirname(dir))).includes("x.json"), false);
});

test("an empty set over an existing account is refused and leaves the files alone", async () => {
  await write([a, b]);
  await assert.rejects(write([]), /would delete 2 stored record/);
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [a, b]);
});

test("a record that moves while another stays ends up stored exactly once", async () => {
  const c = anApiRecord({ id: "c", date: "2025-07-01" });
  await write([a, c]);
  const moved = { ...a, date: "2026-03-01" };
  await write([c, moved]);
  assert.deepEqual(await readAccountSource(dir, "bnka-current", "api"), [c, moved]);
});
