import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SyncError } from "./errors.ts";

// One writing command at a time. The archive's store assumes a single writer per account,
// and a manual run overlapping the nightly one would otherwise overwrite what the other
// had just written. Returns the function that releases the lock.
export const takeLock = async (
  stateDir: string,
  pid: number,
  isAlive: (pid: number) => boolean,
): Promise<() => Promise<void>> => {
  const path = join(stateDir, "lock");
  const create = async (): Promise<boolean> => {
    try {
      await writeFile(path, `${pid}\n`, { flag: "wx" });
      return true;
    } catch (error) {
      if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      throw error;
    }
  };

  if (!(await create())) {
    const holder = Number((await readFile(path, "utf8")).trim());
    // A lock naming this process's own id was left by an earlier run with the same id:
    // ids repeat inside a container, and this run has not taken a lock yet.
    if (Number.isInteger(holder) && holder !== pid && isAlive(holder)) {
      throw new SyncError(
        "another run holds the lock in STATE_DIR. If none is running, remove the file named lock there.",
      );
    }
    await rm(path);
    if (!(await create())) throw new SyncError("the lock in STATE_DIR was taken by another run");
  }
  return () => rm(path);
};
