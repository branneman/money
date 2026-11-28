import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { writeAtomic } from "./atomic.ts";

const inTemporaryDirectory = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "atomic-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("writeAtomic replaces a file whole", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "name");
    await writeFile(path, "old content");
    await writeAtomic(path, "new content");
    assert.equal(await readFile(path, "utf8"), "new content");
    assert.deepEqual(await readdir(dir), ["name"]);
  });
});

test("writeAtomic creates the file with the mode it is given", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "secret");
    await writeAtomic(path, "x", 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
