// The only place the archive touches the disk. Node only: import it as @money/shared/node.
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseYearFile, YEAR_FILE } from "./files.ts";
import { ACCOUNT_KEY, ArchiveError, identityOf } from "./record.ts";
import type { ArchiveRecord, Source } from "./record.ts";
import { planWrites } from "./writes.ts";

const SOURCES: readonly Source[] = ["api", "import"];

const isMissing = (error: unknown): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";

// A directory's entries, without anything dot-prefixed. A missing directory is empty.
const entries = async (dir: string): Promise<Dirent[]> => {
  try {
    const all = await readdir(dir, { withFileTypes: true });
    return all.filter((entry) => !entry.name.startsWith("."));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
};

// A name that failed its pattern may be anything, so no message here repeats one. Each
// says what was found and where, using only names that have already passed.
const checkLocation = (account: string, source: string): void => {
  if (!ACCOUNT_KEY.test(account)) throw new ArchiveError("the account is not a valid key");
  if (!SOURCES.includes(source as Source)) {
    throw new ArchiveError("the source is neither api nor import");
  }
};

const yearFileNames = async (dir: string, label: string): Promise<string[]> => {
  const found = await entries(dir);
  for (const entry of found) {
    if (!entry.isFile() || !YEAR_FILE.test(entry.name)) {
      throw new ArchiveError(`${label} holds something that is not a year file`);
    }
  }
  return found.map((entry) => entry.name).toSorted();
};

export const readAccountSource = async (
  dataDir: string,
  account: string,
  source: Source,
): Promise<ArchiveRecord[]> => {
  checkLocation(account, source);
  const dir = join(dataDir, account, source);
  const records: ArchiveRecord[] = [];
  for (const name of await yearFileNames(dir, `${account}/${source}`)) {
    const text = await readFile(join(dir, name), "utf8");
    records.push(...parseYearFile(text, { account, source, year: name.slice(0, 4) }));
  }
  const seen = new Set<string>();
  for (const record of records) {
    if (seen.has(record.id)) {
      throw new ArchiveError(`${identityOf(record)} is stored in more than one year file`);
    }
    seen.add(record.id);
  }
  return records;
};

export const readArchive = async (dataDir: string): Promise<ArchiveRecord[]> => {
  const records: ArchiveRecord[] = [];
  for (const account of await entries(dataDir)) {
    if (!account.isDirectory()) {
      throw new ArchiveError("the archive holds a file where account directories belong");
    }
    if (!ACCOUNT_KEY.test(account.name)) {
      throw new ArchiveError("a directory in the archive is not an account key");
    }
    for (const source of await entries(join(dataDir, account.name))) {
      if (!source.isDirectory() || !SOURCES.includes(source.name as Source)) {
        throw new ArchiveError(`${account.name} holds something that is not api or import`);
      }
      records.push(...(await readAccountSource(dataDir, account.name, source.name as Source)));
    }
  }
  return records;
};

// Writes the year files of one account and source, in the order planWrites gives. Each
// file goes to a temporary name and is renamed into place, so a file is the old version
// or the new one, never part of each. The order means a crash can leave a record stored
// twice, which reading reports, and never stored nowhere. The store assumes a single
// writer per account and source.
export const writeYearFiles = async (
  dataDir: string,
  account: string,
  source: Source,
  files: ReadonlyMap<string, string>,
): Promise<{ written: string[]; removed: string[] }> => {
  checkLocation(account, source);
  const dir = join(dataDir, account, source);
  const existing = new Map<string, string>();
  for (const name of await yearFileNames(dir, `${account}/${source}`)) {
    existing.set(name, await readFile(join(dir, name), "utf8"));
  }
  const steps = planWrites(existing, files, { account, source });

  // Nothing to do creates nothing, not even the directory.
  if (steps.length > 0) await mkdir(dir, { recursive: true });
  const written = new Set<string>();
  const removed: string[] = [];
  for (const step of steps) {
    if (step.kind === "remove") {
      await rm(join(dir, step.name));
      removed.push(step.name);
      continue;
    }
    const temporary = join(dir, `.${step.name}.tmp`);
    await writeFile(temporary, step.text, { flush: true });
    await rename(temporary, join(dir, step.name));
    written.add(step.name);
  }
  return { written: [...written].toSorted(), removed };
};
