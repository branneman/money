import { link, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SyncError } from "./errors.ts";

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

// The file's text, or null when there is no such file.
const readIfPresent = async (path: string): Promise<string | null> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
};

// A process id is a positive integer in plain digits. Anything else, such as an empty file
// left by a crash, names no process and is a stale lock.
const processId = (text: string): number | null =>
  /^[1-9]\d*$/.test(text.trim()) ? Number(text.trim()) : null;

// Links `source` to `target`, which fails if `target` exists. False when it does.
const linkIfAbsent = async (source: string, target: string): Promise<boolean> => {
  try {
    await link(source, target);
    return true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) return false;
    throw error;
  }
};

// One writing command at a time. The archive's store assumes a single writer per account,
// and a manual run overlapping the nightly one would otherwise overwrite what the other
// had just written. Returns the function that releases the lock.
export const takeLock = async (
  stateDir: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): Promise<() => Promise<void>> => {
  const path = join(stateDir, "lock");
  const mine = `${pid}\n`;
  const held = (): SyncError =>
    new SyncError(
      "another run holds the lock in STATE_DIR. If none is running, remove the file named lock there.",
    );

  // The lock appears whole or not at all: its content is written to a file of its own,
  // which is then linked to the lock's name. The link fails if the lock exists.
  const create = async (): Promise<boolean> => {
    const temporary = join(stateDir, `.lock.${pid}.tmp`);
    try {
      await writeFile(temporary, mine);
      return await linkIfAbsent(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const createOrRefuse = async (): Promise<void> => {
    if (!(await create())) throw held();
  };

  // Moves the lock aside before deciding anything about it, so that what is judged is what
  // is removed. If a live run's fresh lock was moved by mistake, it goes back.
  const takeOver = async (judged: string): Promise<void> => {
    const aside = join(stateDir, `.lock.${pid}.stale`);
    try {
      await rename(path, aside);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return createOrRefuse();
      throw error;
    }
    if ((await readFile(aside, "utf8")) === judged) {
      await rm(aside);
      return createOrRefuse();
    }
    await linkIfAbsent(aside, path);
    await rm(aside);
    throw held();
  };

  if (!(await create())) {
    const text = await readIfPresent(path);
    if (text === null) {
      await createOrRefuse();
    } else {
      const holder = processId(text);
      // A lock naming this process's own id was left by an earlier run with the same id:
      // ids repeat inside a container, and this run has not taken a lock yet.
      if (holder !== null && holder !== pid && isAlive(holder)) throw held();
      await takeOver(text);
    }
  }

  // Only a lock still holding this process's id is released: another run may have taken
  // the lock over.
  return async () => {
    if ((await readIfPresent(path)) === mine) await rm(path, { force: true });
  };
};
