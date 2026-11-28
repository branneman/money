import assert from "node:assert/strict";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { makeLive } from "./live.ts";

const inTemporaryDirectory = async (body: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "live-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// Replaces by a rename, as the host does, so the inode changes too.
const replace = async (dir: string, path: string, text: string): Promise<void> => {
  const next = join(dir, "next");
  await writeFile(next, text);
  await rename(next, path);
};

const counting = () => {
  const state = { reads: 0, invalid: 0 };
  const parse = (text: string): string | null => {
    state.reads += 1;
    return text.startsWith("good") ? text : null;
  };
  return {
    state,
    parse,
    onInvalid: () => {
      state.invalid += 1;
    },
  };
};

test("the first call reads and parses the file", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "f");
    await writeFile(path, "good one");
    const { state, parse, onInvalid } = counting();
    const live = makeLive(path, parse, onInvalid);
    assert.equal(await live.current(), "good one");
    assert.equal(state.reads, 1);
  });
});

test("an unchanged file is not read again", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "f");
    await writeFile(path, "good one");
    const { state, parse, onInvalid } = counting();
    const live = makeLive(path, parse, onInvalid);
    await live.current();
    await live.current();
    assert.equal(state.reads, 1);
  });
});

test("a file replaced by a rename is read again", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "f");
    await writeFile(path, "good one");
    const { state, parse, onInvalid } = counting();
    const live = makeLive(path, parse, onInvalid);
    await live.current();
    await replace(dir, path, "good two");
    assert.equal(await live.current(), "good two");
    assert.equal(state.reads, 2);
  });
});

test("a replacement that does not parse gives null, and onInvalid once across two calls", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "f");
    await writeFile(path, "good one");
    const { state, parse, onInvalid } = counting();
    const live = makeLive(path, parse, onInvalid);
    await live.current();
    await replace(dir, path, "bad");
    assert.equal(await live.current(), null);
    assert.equal(await live.current(), null);
    assert.equal(state.invalid, 1);
    assert.equal(state.reads, 2);
  });
});

test("a removed file gives null, and restored it is served again", async () => {
  await inTemporaryDirectory(async (dir) => {
    const path = join(dir, "f");
    await writeFile(path, "good one");
    const { state, parse, onInvalid } = counting();
    const live = makeLive(path, parse, onInvalid);
    await live.current();
    await rm(path);
    assert.equal(await live.current(), null);
    assert.equal(await live.current(), null);
    assert.equal(state.invalid, 1);
    await replace(dir, path, "good again");
    assert.equal(await live.current(), "good again");
  });
});

test("a file that never existed gives null and calls onInvalid once", async () => {
  await inTemporaryDirectory(async (dir) => {
    const { state, parse, onInvalid } = counting();
    const live = makeLive(join(dir, "missing"), parse, onInvalid);
    assert.equal(await live.current(), null);
    assert.equal(await live.current(), null);
    assert.equal(state.invalid, 1);
  });
});

test("an error other than missing or unreadable propagates", async () => {
  await inTemporaryDirectory(async (dir) => {
    const { parse, onInvalid } = counting();
    // A path through a regular file fails with ENOTDIR.
    const file = join(dir, "f");
    await writeFile(file, "x");
    const live = makeLive(join(file, "below"), parse, onInvalid);
    await assert.rejects(live.current(), { code: "ENOTDIR" });
  });
});
