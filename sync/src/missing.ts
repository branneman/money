import type { ArchiveRecord } from "@money/shared";

import type { DatedWindow } from "./window.ts";

// The ids of stored records that a completed fetch of this window should have returned and
// did not. The merge cannot see this, because it does not know the window. The records are
// kept either way; this only says that a bank withdrew a booking or changed an identifier.
export const missingIds = (
  stored: readonly ArchiveRecord[],
  fetched: ReadonlySet<string>,
  window: DatedWindow,
): string[] =>
  stored
    .filter(
      (record) =>
        record.date >= window.dateFrom && record.date <= window.dateTo && !fetched.has(record.id),
    )
    .map((record) => record.id)
    .toSorted();

// A missing record alerts once, not on every night it stays inside the lookback.
export const newlyMissing = (missing: readonly string[], reported: readonly string[]): string[] =>
  missing.filter((id) => !reported.includes(id));
