import { deepEqual } from "../util/equal.ts";
import { identityOf } from "./record.ts";
import type { ArchiveRecord } from "./record.ts";

// True when `later` is `earlier` after one or more further revisions: the same first
// sighting, `earlier`'s history as the start of `later`'s, and `earlier`'s current version
// as the entry that follows it.
const isAhead = (later: ArchiveRecord, earlier: ArchiveRecord): boolean =>
  later.first_seen === earlier.first_seen &&
  later.revisions.length > earlier.revisions.length &&
  deepEqual(later.revisions.slice(0, earlier.revisions.length), earlier.revisions) &&
  deepEqual(later.revisions[earlier.revisions.length].raw, earlier.raw);

// A write interrupted while a revised record moved to another year leaves two copies: the
// earlier version in the year it left and the revised one in the year it reached. Given two
// copies, returns the one to keep, or null when they are not that pair. Never guesses.
export const laterCopy = (a: ArchiveRecord, b: ArchiveRecord): ArchiveRecord | null => {
  if (identityOf(a) !== identityOf(b)) return null;
  if (isAhead(a, b)) return a;
  if (isAhead(b, a)) return b;
  return null;
};
