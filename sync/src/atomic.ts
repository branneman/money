import { rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

// Writes to a dot-prefixed neighbour and renames it into place, so the file is the old
// version or the new one and never part of each. The directory must exist.
export const writeAtomic = async (path: string, text: string): Promise<void> => {
  const temporary = join(dirname(path), `.${basename(path)}.tmp`);
  await writeFile(temporary, text, { flush: true });
  await rename(temporary, path);
};
