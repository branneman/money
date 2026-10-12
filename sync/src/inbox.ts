// The sync's working area, $DATA_DIR/.inbox. Every page a bank returns is written here, as
// received, before the next one is asked for, and merged from here afterwards. Nothing a
// bank sent can then be lost between receiving it and merging it.
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { isIsoDate, isObject, isTimestamp } from "@money/shared";

import { writeAtomic } from "./atomic.ts";
import { SyncError } from "./errors.ts";
import type { Window } from "./window.ts";

// Written last. A run that has one was received in full.
export type Marker = { started: string; window: Window; pages: number };

export type InboxRun = { name: string; marker: Marker | null; pages: string[] };

const RUN = /^\d{8}T\d{6}Z$/;
const PAGE = /^([1-9]\d*)\.json$/;
const MARKER = "complete.json";

const runDir = (dataDir: string, account: string, run: string): string =>
  join(dataDir, ".inbox", account, run);

export const writePage = async (
  dataDir: string,
  account: string,
  run: string,
  number: number,
  text: string,
): Promise<void> => {
  const dir = runDir(dataDir, account, run);
  await mkdir(dir, { recursive: true });
  await writeAtomic(join(dir, `${number}.json`), text);
};

export const completeRun = (
  dataDir: string,
  account: string,
  run: string,
  marker: Marker,
): Promise<void> =>
  writeAtomic(join(runDir(dataDir, account, run), MARKER), `${JSON.stringify(marker, null, 2)}\n`);

export const removeRun = (dataDir: string, account: string, run: string): Promise<void> =>
  rm(runDir(dataDir, account, run), { recursive: true });

// A directory's names, without anything dot-prefixed. A missing directory is empty.
const visible = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).filter((name) => !name.startsWith(".")).toSorted();
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
};

const isWindow = (value: unknown): value is Window =>
  isObject(value) &&
  (value.strategy === "longest" ||
    (value.strategy === "default" &&
      typeof value.dateFrom === "string" &&
      isIsoDate(value.dateFrom) &&
      typeof value.dateTo === "string" &&
      isIsoDate(value.dateTo)));

const readMarker = (text: string, where: string): Marker => {
  const refuse = (): never => {
    throw new SyncError(`${where}: the marker is not one the sync wrote`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse();
  }
  if (!isObject(parsed)) return refuse();
  const { started, window, pages } = parsed;
  if (typeof started !== "string" || !isTimestamp(started)) return refuse();
  if (!isWindow(window)) return refuse();
  if (typeof pages !== "number" || !Number.isInteger(pages) || pages < 1) return refuse();
  return { started, window, pages };
};

// Every run in an account's inbox, oldest first, with the text of each page. A run's name
// is its start time in a fixed width, so sorting the names sorts the runs.
export const listRuns = async (dataDir: string, account: string): Promise<InboxRun[]> => {
  const root = join(dataDir, ".inbox", account);
  const runs: InboxRun[] = [];
  for (const name of await visible(root)) {
    if (!RUN.test(name)) {
      throw new SyncError(`the inbox of ${account} holds something that is not a run`);
    }
    const where = `${account}, run ${name}`;
    const files = await visible(join(root, name));
    const numbers: number[] = [];
    for (const file of files) {
      if (file === MARKER) continue;
      const match = PAGE.exec(file);
      if (match === null) throw new SyncError(`${where} holds something that is not a page`);
      numbers.push(Number(match[1]));
    }
    numbers.sort((a, b) => a - b);
    numbers.forEach((number, index) => {
      if (number !== index + 1) throw new SyncError(`${where}: page ${index + 1} is absent`);
    });
    const pages: string[] = [];
    for (const number of numbers) {
      pages.push(await readFile(join(root, name, `${number}.json`), "utf8"));
    }
    let marker: Marker | null = null;
    if (files.includes(MARKER)) {
      marker = readMarker(await readFile(join(root, name, MARKER), "utf8"), where);
      if (marker.pages !== pages.length) {
        throw new SyncError(
          `${where}: the marker counts ${marker.pages} pages and ${pages.length} are there`,
        );
      }
    }
    runs.push({ name, marker, pages });
  }
  return runs;
};
