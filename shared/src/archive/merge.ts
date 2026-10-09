import { isIsoDate } from "../util/dates.ts";
import { deepEqual } from "../util/equal.ts";
import { identityOf } from "./record.ts";
import type { ApiRaw, ArchiveRecord, ImportRaw } from "./record.ts";

// One transaction on its way into the archive. Whoever fetched or imported it has already
// read its identifier and booking date out of `raw`.
export type Incoming = {
  readonly id: string;
  readonly date: string;
  readonly raw: ApiRaw | ImportRaw;
};

export type Target =
  | { readonly account: string; readonly source: "api" }
  | { readonly account: string; readonly source: "import"; readonly format: string };

export type MergeResult = {
  records: ArchiveRecord[];
  added: string[];
  revised: string[];
  unchanged: number;
};

export class MergeError extends Error {}

export const compareRecords = (a: ArchiveRecord, b: ArchiveRecord): number =>
  a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

// The object literals fix the key order that year files are written in.
const create = (target: Target, item: Incoming, now: string): ArchiveRecord =>
  target.source === "api"
    ? {
        account: target.account,
        source: "api",
        id: item.id,
        date: item.date,
        first_seen: now,
        revisions: [],
        raw: item.raw,
      }
    : {
        account: target.account,
        source: "import",
        id: item.id,
        format: target.format,
        date: item.date,
        first_seen: now,
        revisions: [],
        raw: item.raw as ImportRaw,
      };

const revise = (existing: ArchiveRecord, item: Incoming, now: string): ArchiveRecord =>
  ({
    ...existing,
    date: item.date,
    revisions: [...existing.revisions, { replaced_at: now, raw: existing.raw }],
    raw: item.raw,
  }) as ArchiveRecord;

// Merges one batch into everything stored for one account and source. Never deletes, and
// never decides that two transactions are the same by looking at their contents.
export const merge = (
  stored: readonly ArchiveRecord[],
  incoming: readonly Incoming[],
  target: Target,
  now: string,
): MergeResult => {
  const byId = new Map<string, ArchiveRecord>();
  for (const record of stored) {
    if (record.account !== target.account || record.source !== target.source) {
      throw new MergeError(
        `${identityOf(record)} does not belong to ${target.account}/${target.source}`,
      );
    }
    if (byId.has(record.id)) throw new MergeError(`${identityOf(record)} is stored twice`);
    byId.set(record.id, record);
  }

  const batch = new Map<string, Incoming>();
  const added: string[] = [];
  const revised: string[] = [];
  let unchanged = 0;

  for (const item of incoming) {
    const identity = identityOf({ ...target, id: item.id });
    if (item.id === "")
      throw new MergeError(`${target.account}/${target.source}: a transaction has no id`);
    if (!isIsoDate(item.date)) throw new MergeError(`${identity} has no usable booking date`);

    const earlier = batch.get(item.id);
    if (earlier !== undefined) {
      if (deepEqual(earlier, item)) continue;
      throw new MergeError(`${identity} appears twice in one batch with different contents`);
    }
    batch.set(item.id, item);

    const existing = byId.get(item.id);
    if (existing === undefined) {
      byId.set(item.id, create(target, item, now));
      added.push(identity);
    } else if (existing.date === item.date && deepEqual(existing.raw, item.raw)) {
      unchanged += 1;
    } else {
      byId.set(item.id, revise(existing, item, now));
      revised.push(identity);
    }
  }

  return { records: [...byId.values()].toSorted(compareRecords), added, revised, unchanged };
};
