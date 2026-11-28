import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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

test("writeAtomic removes a symlink at the temporary path and does not write through it", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "secret");
    const victim = join(dir, "victim");
    await writeFile(victim, "untouched");
    await symlink(victim, join(dir, ".secret.tmp"));
    await writeAtomic(path, "x", 0o600);
    assert.equal(await readFile(victim, "utf8"), "untouched");
    assert.equal((await lstat(path)).isFile(), true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test("writeAtomic gives the file the mode asked for even over a stale temporary file", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "secret");
    const stale = join(dir, ".secret.tmp");
    await writeFile(stale, "left by a crash");
    await chmod(stale, 0o644);
    await writeAtomic(path, "x", 0o600);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});
