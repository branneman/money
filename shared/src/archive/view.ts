import type { ImportFormat } from "../config/config.ts";
import { normalise } from "./normalise.ts";
import type { Transaction } from "./normalise.ts";
import type { ArchiveRecord } from "./record.ts";

export const apiStarts = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const starts = new Map<string, string>();
  for (const record of records) {
    if (record.source !== "api") continue;
    const current = starts.get(record.account);
    if (current === undefined || record.date < current) starts.set(record.account, record.date);
  }
  return starts;
};

// The same real transaction can be stored twice, once fetched and once imported. From the
// first day the API covers an account, the API's copy is the one that is shown. This
// depends only on what is stored, never on the order things were done in.
export const visibleRecords = (records: readonly ArchiveRecord[]): ArchiveRecord[] => {
  const starts = apiStarts(records);
  return records.filter((record) => {
    if (record.source === "api") return true;
    const start = starts.get(record.account);
    return start === undefined || record.date < start;
  });
};

const sortKey = (item: Transaction): string =>
  `${item.date}\u0000${item.account}\u0000${item.source}\u0000${item.id}`;

export const view = (
  records: readonly ArchiveRecord[],
  formats: Readonly<Record<string, ImportFormat>>,
): Transaction[] =>
  visibleRecords(records)
    .map((record) => normalise(record, formats))
    .toSorted((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
