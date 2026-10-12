import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { SyncError } from "./errors.ts";
import { takeLock } from "./lock.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-lock-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const nobody = (): boolean => false;
const everybody = (): boolean => true;

test("the lock holds this process's id, and releasing removes it", async () => {
  const release = await takeLock(dir, 4242, nobody);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
  await release();
  assert.deepEqual(await readdir(dir), []);
});

test("a lock held by a live process stops the command and is left alone", async () => {
  await writeFile(join(dir, "lock"), "999\n");
  await assert.rejects(
    takeLock(dir, 4242, (pid) => pid === 999),
    (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.equal(
        error.message,
        "another run holds the lock in STATE_DIR. If none is running, remove the file named lock there.",
      );
      return true;
    },
  );
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "999\n");
});

test("a lock left by a process that is gone is taken over", async () => {
  await writeFile(join(dir, "lock"), "999\n");
  const release = await takeLock(dir, 4242, nobody);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
  await release();
});

// Process ids repeat inside a container. A lock that names this very process was left by
// an earlier run that had the same id, since this run has not taken one yet.
test("a lock that names this process's own id is taken over", async () => {
  await writeFile(join(dir, "lock"), "4242\n");
  const release = await takeLock(dir, 4242, everybody);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
  await release();
});

test("a lock that holds no process id is taken over", async () => {
  await writeFile(join(dir, "lock"), "not a number");
  const release = await takeLock(dir, 4242, everybody);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
  await release();
});

// Process id 0 reports alive to a liveness check, so an empty lock must never be read as 0.
test("a lock that is empty, or whose content is not plain digits, is taken over", async () => {
  for (const content of ["", "\n", "0\n", "-1\n", "1e3\n", "0x10\n", "12 34\n"]) {
    await writeFile(join(dir, "lock"), content);
    const release = await takeLock(dir, 4242, everybody);
    assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
    await release();
    assert.deepEqual(await readdir(dir), []);
  }
});

test("no temporary file is left after taking the lock or failing to", async () => {
  const release = await takeLock(dir, 4242, nobody);
  assert.deepEqual(await readdir(dir), ["lock"]);
  await assert.rejects(takeLock(dir, 4243, everybody), SyncError);
  assert.deepEqual(await readdir(dir), ["lock"]);
  await release();
});

test("releasing leaves a lock that another run took over", async () => {
  const release = await takeLock(dir, 4242, nobody);
  await writeFile(join(dir, "lock"), "777\n");
  await release();
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "777\n");
});

test("releasing when the lock is already gone is not an error", async () => {
  const release = await takeLock(dir, 4242, nobody);
  await rm(join(dir, "lock"));
  await release();
  assert.deepEqual(await readdir(dir), []);
});

test("a fresh lock that appears while a stale one is judged is put back and respected", async () => {
  await writeFile(join(dir, "lock"), "999\n");
  const otherRunWins = (): boolean => {
    writeFileSync(join(dir, "lock"), "777\n");
    return false;
  };
  await assert.rejects(takeLock(dir, 4242, otherRunWins), (error: unknown) => {
    assert.ok(error instanceof SyncError);
    assert.match(error.message, /^another run holds the lock/);
    return true;
  });
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "777\n");
  assert.deepEqual(await readdir(dir), ["lock"]);
});

test("a lock that vanishes while a stale one is judged is simply taken", async () => {
  await writeFile(join(dir, "lock"), "999\n");
  const holderReleases = (): boolean => {
    rmSync(join(dir, "lock"));
    return false;
  };
  const release = await takeLock(dir, 4242, holderReleases);
  assert.equal(await readFile(join(dir, "lock"), "utf8"), "4242\n");
  await release();
  assert.deepEqual(await readdir(dir), []);
});
