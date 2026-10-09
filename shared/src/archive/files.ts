import { compareRecords } from "./merge.ts";
import { ArchiveError, checkRecord } from "./record.ts";
import type { ArchiveRecord, Source } from "./record.ts";

export type FileLocation = { account: string; source: Source; year: string };

// File name to exact file text, for the records of one account and source. A year with no
// records gets no file.
export const renderYearFiles = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const byYear = Map.groupBy(records, (record) => record.date.slice(0, 4));
  return new Map(
    [...byYear].map(([year, items]) => [
      `${year}.json`,
      `${JSON.stringify(items.toSorted(compareRecords), null, 2)}\n`,
    ]),
  );
};

// Parses and checks one year file. A file that is wrong in any way is rejected whole.
export const parseYearFile = (text: string, where: FileLocation): ArchiveRecord[] => {
  const file = `${where.account}/${where.source}/${where.year}.json`;
  const parse = (): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new ArchiveError(`${file} is not valid JSON`);
    }
  };
  const parsed = parse();
  if (!Array.isArray(parsed)) throw new ArchiveError(`${file} is not a list of records`);

  const records = (parsed as unknown[]).map((value, index) => {
    const position = `${file}, record ${index + 1}`;
    const record = checkRecord(value, position);
    if (record.account !== where.account)
      throw new ArchiveError(`${position}: is of another account`);
    if (record.source !== where.source) throw new ArchiveError(`${position}: is of another source`);
    if (record.date.slice(0, 4) !== where.year) {
      throw new ArchiveError(`${position}: belongs in ${record.date.slice(0, 4)}`);
    }
    return record;
  });

  // Strictly ascending also rules out the same id twice on one date.
  records.forEach((record, index) => {
    if (index > 0 && compareRecords(records[index - 1], record) >= 0) {
      throw new ArchiveError(`${file}, record ${index + 1}: is out of order`);
    }
  });
  const ids = new Set(records.map((record) => record.id));
  if (ids.size !== records.length) throw new ArchiveError(`${file}: holds an id twice`);
  return records;
};
