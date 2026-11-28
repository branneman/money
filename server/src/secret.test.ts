import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SECRET_FILE, parseSecret, rotateSecret } from "./secret.ts";

const b64 = (size: number, fill = 7): string => Buffer.alloc(size, fill).toString("base64");

test("32 bytes of base64 are accepted, with or without a trailing newline", () => {
  assert.deepEqual(parseSecret(b64(32)), Buffer.alloc(32, 7));
  assert.deepEqual(parseSecret(b64(32) + "\n"), Buffer.alloc(32, 7));
});

test("31 and 33 bytes are refused", () => {
  assert.equal(parseSecret(b64(31)), null);
  assert.equal(parseSecret(b64(33)), null);
});

test("two lines are refused", () => {
  assert.equal(parseSecret(`${b64(32)}\n${b64(32)}\n`), null);
});

test("text that is not standard base64 is refused", () => {
  assert.equal(parseSecret("not base64 at all!!"), null);
  assert.equal(parseSecret(b64(32).replace(/.$/, "*")), null);
  assert.equal(parseSecret(Buffer.alloc(32, 0xfb).toString("base64url")), null);
  assert.equal(parseSecret(""), null);
});

const inTemporaryDirectory = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "secret-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("rotateSecret writes an owner-only file that parseSecret accepts, and a second differs", async () => {
  await inTemporaryDirectory(async (dir) => {
    await rotateSecret(dir, randomBytes);
    const path = join(dir, SECRET_FILE);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    const first = await readFile(path, "utf8");
    assert.notEqual(parseSecret(first), null);
    await rotateSecret(dir, randomBytes);
    assert.notEqual(await readFile(path, "utf8"), first);
  });
});

test("rotateSecret over a stale world-readable temporary file still ends at 0600", async () => {
  await inTemporaryDirectory(async (dir) => {
    const stale = join(dir, `.${SECRET_FILE}.tmp`);
    await writeFile(stale, "left by a crash");
    await chmod(stale, 0o644);
    await rotateSecret(dir, (size) => Buffer.alloc(size, 9));
    assert.equal((await stat(join(dir, SECRET_FILE))).mode & 0o777, 0o600);
  });
});
