import assert from "node:assert/strict";
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
