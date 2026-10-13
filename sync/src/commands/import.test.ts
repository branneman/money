import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import { normalise, renderYearFiles } from "@money/shared";
import type { ArchiveRecord, Config } from "@money/shared";
import { readAccountSource } from "@money/shared/node";
import { aFormat, anImportRaw } from "@money/shared/testing";

import { renderExport } from "../../testing/export.ts";
import { makeWorld, worldConfig } from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";

const FORMAT = "example-export";
const HEADER = Object.keys(anImportRaw());
const row = (overrides: Record<string, string> = {}): string[] =>
  Object.values(anImportRaw(overrides));

const start = async (
  t: TestContext,
  imports: Config["imports"] = { [FORMAT]: aFormat() },
): Promise<World> => {
  const world = await makeWorld({ config: { ...worldConfig(), imports } });
  t.after(world.cleanup);
  return world;
};

const put = async (
  world: World,
  content: string | Uint8Array,
  name = "export.csv",
): Promise<string> => {
  const path = join(dirname(world.dataDir), name);
  await writeFile(path, content);
  return path;
};
const exported = (world: World, rows: string[][], name?: string): Promise<string> =>
  put(world, renderExport(HEADER, rows), name);

const stored = (world: World, account: string): Promise<ArchiveRecord[]> =>
  readAccountSource(world.dataDir, account, "import");

const TWO = [row({ Sequence: "1" }), row({ Sequence: "2", Booked: "2025-01-03", Amount: "5,00" })];

test("a check prints the summary and writes nothing, not even a directory or a lock", async (t) => {
  const world = await start(t);
  const path = await exported(world, TWO);
  assert.equal(await world.run("import", FORMAT, path), 0);
  assert.deepEqual(world.lines, [
    "import-account account=bnka-current rows=2 new=2 changed=0 unchanged=0 from=2025-01-02 to=2025-01-03",
    "import-characters distinct=0",
    "import-checked format=example-export accounts=1 rows=2 written=no",
    "Nothing was written. Run the same command with --write to import.",
  ]);
  assert.deepEqual(await readdir(world.dataDir), []);
  assert.deepEqual(await readdir(world.stateDir), []);
});

test("--write stores each row as an import record of the format, readable by the view", async (t) => {
  const world = await start(t);
  const path = await exported(world, TWO);
  assert.equal(await world.run("import", FORMAT, path, "--write"), 0);
  assert.deepEqual(world.lines.slice(-2), [
    "import-written account=bnka-current files=1",
    "import-checked format=example-export accounts=1 rows=2 written=yes",
  ]);
  const records = await stored(world, "bnka-current");
  assert.deepEqual(
    records.map((record) => [record.id, record.date, record.first_seen, record.revisions.length]),
    [
      ["1", "2025-01-02", "2026-03-01T03:00:00Z", 0],
      ["2", "2025-01-03", "2026-03-01T03:00:00Z", 0],
    ],
  );
  assert.deepEqual(records[0].raw, anImportRaw({ Sequence: "1" }));
  assert.ok(records.every((record) => record.source === "import" && record.format === FORMAT));
  assert.deepEqual(
    records.map((record) => normalise(record, world.config.imports).amount),
    [-1234, 500],
  );
  assert.deepEqual([...(await world.files()).keys()], ["bnka-current/import/2025.json"]);
  // The lock was released.
  assert.deepEqual(await readdir(world.stateDir), []);
});

test("the same file twice changes nothing, byte for byte", async (t) => {
  const world = await start(t);
  const path = await exported(world, TWO);
  assert.equal(await world.run("import", FORMAT, path, "--write"), 0);
  const before = await world.files();
  world.at("2026-04-01T10:00:00Z");
  world.lines.length = 0;
  assert.equal(await world.run("import", FORMAT, path, "--write"), 0);
  assert.deepEqual(await world.files(), before);
  assert.deepEqual(world.lines, [
    "import-account account=bnka-current rows=2 new=0 changed=0 unchanged=2 from=2025-01-02 to=2025-01-03",
    "import-characters distinct=0",
    "import-written account=bnka-current files=0",
    "import-checked format=example-export accounts=1 rows=2 written=yes",
  ]);
});

test("a later export that overlaps adds only what is new", async (t) => {
  const world = await start(t);
  assert.equal(await world.run("import", FORMAT, await exported(world, TWO), "--write"), 0);
  world.at("2026-04-01T10:00:00Z");
  world.lines.length = 0;
  const later = [TWO[1], row({ Sequence: "3", Booked: "2025-01-04" })];
  assert.equal(await world.run("import", FORMAT, await exported(world, later), "--write"), 0);
  assert.match(world.lines[0], /rows=2 new=1 changed=0 unchanged=1/);
  const records = await stored(world, "bnka-current");
  assert.deepEqual(
    records.map((record) => [record.id, record.first_seen]),
    [
      ["1", "2026-03-01T03:00:00Z"],
      ["2", "2026-03-01T03:00:00Z"],
      ["3", "2026-04-01T10:00:00Z"],
    ],
  );
});

test("a row that differs from what is stored becomes a revision, and is counted as changed", async (t) => {
  const world = await start(t);
  assert.equal(await world.run("import", FORMAT, await exported(world, TWO), "--write"), 0);
  world.at("2026-04-01T10:00:00Z");
  world.lines.length = 0;
  const changed = [row({ Sequence: "1", "Text 1": "Another line" })];
  assert.equal(await world.run("import", FORMAT, await exported(world, changed), "--write"), 0);
  assert.match(world.lines[0], /rows=1 new=0 changed=1 unchanged=0/);
  const [first] = await stored(world, "bnka-current");
  assert.equal(first.raw["Text 1"], "Another line");
  assert.deepEqual(first.revisions, [
    { replaced_at: "2026-04-01T10:00:00Z", raw: anImportRaw({ Sequence: "1" }) },
  ]);
});

test("a file for two accounts lands per account, and per year", async (t) => {
  const world = await start(t);
  const rows = [
    row({ Sequence: "1", Booked: "2024-12-31" }),
    row({ Sequence: "2" }),
    row({ Account: "1001", Sequence: "1" }),
  ];
  assert.equal(await world.run("import", FORMAT, await exported(world, rows), "--write"), 0);
  assert.deepEqual(
    [...(await world.files()).keys()],
    [
      "bnka-card/import/2025.json",
      "bnka-current/import/2024.json",
      "bnka-current/import/2025.json",
    ],
  );
  assert.deepEqual(world.lines.slice(0, 2), [
    "import-account account=bnka-card rows=1 new=1 changed=0 unchanged=0 from=2025-01-02 to=2025-01-02",
    "import-account account=bnka-current rows=2 new=2 changed=0 unchanged=0 from=2024-12-31 to=2025-01-02",
  ]);
});

test("one bad row among good ones writes nothing, even with --write", async (t) => {
  const world = await start(t);
  const rows = [...TWO, row({ Sequence: "3", Amount: "1.234,56" })];
  assert.equal(await world.run("import", FORMAT, await exported(world, rows), "--write"), 1);
  assert.deepEqual(world.lines, ["row 4 has an amount that cannot be read"]);
  assert.equal((await world.files()).size, 0);
});

test("a file in a single-byte encoding is stored as the text it means", async (t) => {
  const world = await start(t, { [FORMAT]: aFormat({ encoding: "windows-1252" }) });
  const text = renderExport(HEADER, [row({ Counterparty: "Café €" })]);
  const bytes = Uint8Array.from(
    [...text].map((character) =>
      character === "é" ? 0xe9 : character === "€" ? 0x80 : character.charCodeAt(0),
    ),
  );
  assert.equal(await world.run("import", FORMAT, await put(world, bytes), "--write"), 0);
  assert.equal((await stored(world, "bnka-current"))[0].raw.Counterparty, "Café €");
  assert.deepEqual(world.lines.slice(1, 4), [
    "import-characters distinct=2",
    "  U+00E9 é 1",
    "  U+20AC € 1",
  ]);
});

test("a stored record under another format refuses the file", async (t) => {
  const world = await start(t, { [FORMAT]: aFormat(), "other-export": aFormat() });
  const path = await exported(world, TWO);
  assert.equal(await world.run("import", FORMAT, path, "--write"), 0);
  const before = await world.files();
  world.lines.length = 0;
  assert.equal(await world.run("import", "other-export", path, "--write"), 1);
  assert.deepEqual(world.lines, [
    "bnka-current: 2 of the file's identifiers are stored under another import format",
  ]);
  assert.deepEqual(await world.files(), before);
});

test("a held lock stops --write and does not stop a check", async (t) => {
  const world = await start(t);
  const path = await exported(world, TWO);
  await writeFile(join(world.stateDir, "lock"), "999\n");
  world.alive.add(999);
  assert.equal(await world.run("import", FORMAT, path, "--write"), 1);
  assert.match(world.lines.join("\n"), /another run holds the lock/);
  assert.equal((await world.files()).size, 0);
  world.lines.length = 0;
  assert.equal(await world.run("import", FORMAT, path), 0);
});

test("a format key that is not configured lists the ones that are, and repeats nothing", async (t) => {
  const world = await start(t);
  const path = await exported(world, TWO);
  assert.equal(await world.run("import", "Zqx Format", path), 1);
  assert.deepEqual(world.lines, [
    "no import format is configured under that key. Configured: example-export",
  ]);
});

test("a path that names no file fails with the code, and never the path", async (t) => {
  const world = await start(t);
  const folder = join(dirname(world.dataDir), "zqxfolder");
  await mkdir(folder);
  assert.equal(await world.run("import", FORMAT, join(folder, "zqxmissing.csv")), 1);
  assert.equal(await world.run("import", FORMAT, folder), 1);
  assert.deepEqual(world.lines, [
    "the file to import cannot be read (ENOENT)",
    "the file to import cannot be read (EISDIR)",
  ]);
});

test("import takes a format, a file, and --write only at the end", async (t) => {
  const world = await start(t);
  for (const argv of [
    ["import"],
    ["import", FORMAT],
    ["import", "--write", FORMAT, "file.csv"],
    ["import", FORMAT, "--write"],
    ["import", FORMAT, "file.csv", "--force"],
    ["import", FORMAT, "file.csv", "--write", "extra"],
  ]) {
    world.lines.length = 0;
    assert.equal(await world.run(...argv), 1);
    assert.deepEqual(world.lines, [
      "usage: auth <bank> [--show-ibans] | sync | status | banks <country> | import <format> <file> [--write]",
    ]);
  }
});

// What a write interrupted between two year files leaves: the revised record in the year
// it moved to, and its earlier version still in the year it left.
const leaveDoubled = async (world: World): Promise<void> => {
  const [earlier] = await stored(world, "bnka-current");
  const later = {
    ...earlier,
    date: "2024-12-31",
    revisions: [{ replaced_at: "2026-03-02T03:00:00Z", raw: earlier.raw }],
    raw: { ...earlier.raw, Booked: "2024-12-31" },
  } as ArchiveRecord;
  const [[name, text]] = [...renderYearFiles([later])];
  await writeFile(join(world.dataDir, "bnka-current", "import", name), text);
};

test("a record left in two year files stops a check, and is repaired under --write", async (t) => {
  const world = await start(t);
  const one = [row({ Sequence: "1" })];
  assert.equal(await world.run("import", FORMAT, await exported(world, one), "--write"), 0);
  await leaveDoubled(world);
  const moved = await exported(world, [row({ Sequence: "1", Booked: "2024-12-31" })]);

  world.lines.length = 0;
  assert.equal(await world.run("import", FORMAT, moved), 1);
  assert.match(world.lines.join("\n"), /is stored in more than one year file/);

  world.lines.length = 0;
  assert.equal(await world.run("import", FORMAT, moved, "--write"), 0);
  assert.match(world.lines[0], /rows=1 new=0 changed=0 unchanged=1/);
  assert.deepEqual([...(await world.files()).keys()], ["bnka-current/import/2024.json"]);
});
