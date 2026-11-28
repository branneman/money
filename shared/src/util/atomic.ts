import { rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Writes to a dot-prefixed neighbour and renames it into place, so the file is the old
// version or the new one and never part of each. The neighbour is created with the given
// mode (any stale one is removed first), so the file never exists with wider permissions.
// The directory must exist.
export const writeAtomic = async (
  path: string,
  text: string,
  mode: number = 0o644,
): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  // A neighbour left by a crash would keep its own mode, since the mode applies only when
  // the file is created.
  await rm(temporary, { force: true });
  // "wx": a file or link planted since the remove makes this fail, never write through it.
  await writeFile(temporary, text, { flush: true, mode, flag: "wx" });
  await rename(temporary, path);
};
