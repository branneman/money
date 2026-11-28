import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { directoryProblem } from "./directories.ts";

const inTemporaryDirectory = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "directories-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("an existing directory has no problem", async () => {
  await inTemporaryDirectory(async (root) => {
    assert.deepEqual(await directoryProblem("DATA_DIR", root), []);
  });
});

test("an absent path does not name an existing directory", async () => {
  await inTemporaryDirectory(async (root) => {
    assert.deepEqual(await directoryProblem("DATA_DIR", join(root, "nope")), [
      "DATA_DIR does not name an existing directory",
    ]);
  });
});

test("a file in place of a directory does not name an existing directory", async () => {
  await inTemporaryDirectory(async (root) => {
    const file = join(root, "file");
    await writeFile(file, "x");
    assert.deepEqual(await directoryProblem("DATA_DIR", file), [
      "DATA_DIR does not name an existing directory",
    ]);
    assert.deepEqual(await directoryProblem("DATA_DIR", join(file, "below")), [
      "DATA_DIR does not name an existing directory",
    ]);
  });
});
