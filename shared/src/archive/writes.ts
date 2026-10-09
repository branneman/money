// The order in which year files must change on disk. Pure: it decides, the store does.
import { parseYearFile, renderYearFiles, YEAR_FILE } from "./files.ts";
import { ArchiveError } from "./record.ts";
import type { ArchiveRecord, Source } from "./record.ts";

export type WriteStep =
  { kind: "write"; name: string; text: string } | { kind: "remove"; name: string };

type Where = { account: string; source: Source };

const parseAll = (files: ReadonlyMap<string, string>, where: Where): Map<string, ArchiveRecord[]> =>
  new Map(
    [...files].map(([name, text]) => {
      const match = YEAR_FILE.exec(name);
      if (match === null) {
        throw new ArchiveError(`${where.account}/${where.source}/${name} is not a year file name`);
      }
      return [name, parseYearFile(text, { ...where, year: match[1] })];
    }),
  );

const idsOf = (records: readonly ArchiveRecord[]): Set<string> =>
  new Set(records.map((record) => record.id));

// Steps that take one account and source from `existing` to `next`, name -> text for both.
// After any prefix of the steps, every id that was stored is still in at least one file:
// a file that loses ids is first written with the union of old and new records, and
// shrunk only once the files that gain them have been written. A crash can leave a
// record stored twice, which reading reports, and never stored nowhere.
export const planWrites = (
  existing: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  where: Where,
): WriteStep[] => {
  const before = parseAll(existing, where);
  const after = parseAll(next, where);

  const nextIds = new Set<string>();
  for (const records of after.values()) {
    for (const record of records) {
      if (nextIds.has(record.id)) {
        throw new ArchiveError(
          `${where.account}/${where.source}: an id is in more than one year file`,
        );
      }
      nextIds.add(record.id);
    }
  }
  const dropped = new Set(
    [...before.values()]
      .flat()
      .filter((record) => !nextIds.has(record.id))
      .map((r) => r.id),
  );
  if (dropped.size > 0) {
    throw new ArchiveError(
      `${where.account}/${where.source}: writing would delete ${dropped.size} stored record(s)`,
    );
  }

  const changed = [...next.keys()]
    .toSorted()
    .filter((name) => next.get(name) !== existing.get(name));
  const shrinking = changed.filter((name) => {
    const kept = idsOf(after.get(name) ?? []);
    return [...idsOf(before.get(name) ?? [])].some((id) => !kept.has(id));
  });

  const steps: WriteStep[] = [];
  for (const name of changed) {
    const text = next.get(name) ?? "";
    if (!shrinking.includes(name)) {
      steps.push({ kind: "write", name, text });
      continue;
    }
    const merged = new Map<string, ArchiveRecord>();
    for (const record of [...(before.get(name) ?? []), ...(after.get(name) ?? [])]) {
      merged.set(record.id, record);
    }
    const union = renderYearFiles([...merged.values()]).get(name) ?? "";
    if (union !== existing.get(name)) steps.push({ kind: "write", name, text: union });
  }
  for (const name of shrinking) {
    steps.push({ kind: "write", name, text: next.get(name) ?? "" });
  }
  for (const name of [...existing.keys()].toSorted()) {
    if (!next.has(name)) steps.push({ kind: "remove", name });
  }
  return steps;
};
