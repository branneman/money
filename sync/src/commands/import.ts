// Merges a file exported from a bank's website into the archive. It checks by default and
// writes only when asked: an import is permanent, like everything in the archive.
import { readFile } from "node:fs/promises";

import { merge, renderYearFiles } from "@money/shared";
import type { ArchiveRecord, Target } from "@money/shared";
import { readAccountSource, recoverAccountSource, writeYearFiles } from "@money/shared/node";

import type { Context } from "../context.ts";
import { SyncError } from "../errors.ts";
import { describeCharacter, nonAscii } from "../import/characters.ts";
import { decode } from "../import/decode.ts";
import { readDelimited } from "../import/delimited.ts";
import { reject } from "../import/error.ts";
import { readRows } from "../import/rows.ts";
import { timestampOf } from "../time.ts";

const UNREADABLE = ["ENOENT", "EISDIR", "ENOTDIR", "EACCES"];

// The path is typed by a person and may name anything, so the message holds only the code.
const readBytes = async (path: string): Promise<Uint8Array> => {
  try {
    return await readFile(path);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === undefined || !UNREADABLE.includes(code)) throw error;
    throw new SyncError(`the file to import cannot be read (${code})`);
  }
};

type Merged = {
  account: string;
  rows: number;
  added: number;
  revised: number;
  unchanged: number;
  from: string;
  to: string;
  records: ArchiveRecord[];
};

export const runImport = async (
  context: Context,
  formatKey: string,
  path: string,
  write: boolean,
): Promise<number> => {
  const { settings, config, deps, log } = context;
  if (!Object.hasOwn(config.imports, formatKey)) {
    const keys = Object.keys(config.imports).toSorted();
    throw new SyncError(
      `no import format is configured under that key. Configured: ${keys.length > 0 ? keys.join(", ") : "none"}`,
    );
  }
  const format = config.imports[formatKey];
  const text = decode(await readBytes(path), format.encoding);
  const batches = readRows(readDelimited(text, format.delimiter), format, config.accounts);

  // Every account is merged before any is written: a file is accepted or refused whole.
  const now = timestampOf(deps.clock());
  const merged: Merged[] = [];
  const problems: string[] = [];
  for (const { account, incoming } of batches) {
    // A check writes nothing, so it leaves a doubled record to stop it below. A repair is
    // said, as the sync says it.
    if (write) {
      const recovered = await recoverAccountSource(settings.dataDir, account, "import");
      if (recovered > 0) log("recovered", { account, records: recovered });
    }
    const stored = await readAccountSource(settings.dataDir, account, "import");
    // merge would keep the old format key over a raw that it does not describe.
    const ids = new Set(incoming.map((item) => item.id));
    const elsewhere = stored.filter(
      (record) => record.source === "import" && record.format !== formatKey && ids.has(record.id),
    ).length;
    if (elsewhere > 0) {
      problems.push(
        `${account}: ${elsewhere} of the file's identifiers are stored under another import format`,
      );
      continue;
    }
    const target: Target = { account, source: "import", format: formatKey };
    const result = merge(stored, incoming, target, now);
    const dates = incoming.map((item) => item.date).toSorted();
    merged.push({
      account,
      rows: incoming.length,
      added: result.added.length,
      revised: result.revised.length,
      unchanged: result.unchanged,
      from: dates[0],
      to: dates[dates.length - 1],
      records: result.records,
    });
  }
  if (problems.length > 0) throw reject(problems);

  for (const item of merged) {
    log("import-account", {
      account: item.account,
      rows: item.rows,
      new: item.added,
      changed: item.revised,
      unchanged: item.unchanged,
      from: item.from,
      to: item.to,
    });
  }
  // The one thing printed that is not a key, a date or a count: single characters, so that
  // a wrong encoding can be seen before anything is stored.
  const characters = nonAscii(text);
  log("import-characters", { distinct: characters.length });
  for (const found of characters) deps.out(describeCharacter(found));

  if (write) {
    for (const item of merged) {
      const { written } = await writeYearFiles(
        settings.dataDir,
        item.account,
        "import",
        renderYearFiles(item.records),
      );
      log("import-written", { account: item.account, files: written.length });
    }
  }
  log("import-checked", {
    format: formatKey,
    accounts: merged.length,
    rows: merged.reduce((sum, item) => sum + item.rows, 0),
    written: write ? "yes" : "no",
  });
  if (!write) deps.out("Nothing was written. Run the same command with --write to import.");
  return 0;
};
