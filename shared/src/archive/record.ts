import { isIsoDate, isTimestamp } from "../util/dates.ts";

export type Source = "api" | "import";

// A transaction exactly as the Enable Banking API returned it. Only three of its fields
// are guaranteed, so it is read defensively, in normalise.ts, and nowhere else.
export type ApiRaw = { readonly [field: string]: unknown };

// One row of an exported file: column header to cell text, nothing parsed.
export type ImportRaw = { readonly [column: string]: string };

export type Revision<Raw> = { readonly replaced_at: string; readonly raw: Raw };

export type ApiRecord = {
  readonly account: string;
  readonly source: "api";
  readonly id: string;
  readonly date: string;
  readonly first_seen: string;
  readonly revisions: readonly Revision<ApiRaw>[];
  readonly raw: ApiRaw;
};

export type ImportRecord = {
  readonly account: string;
  readonly source: "import";
  readonly id: string;
  readonly format: string;
  readonly date: string;
  readonly first_seen: string;
  readonly revisions: readonly Revision<ImportRaw>[];
  readonly raw: ImportRaw;
};

export type ArchiveRecord = ApiRecord | ImportRecord;

export const ACCOUNT_KEY = /^[a-z0-9-]+$/;

export class ArchiveError extends Error {}

export const identityOf = (record: { account: string; source: Source; id: string }): string =>
  `${record.account}/${record.source}/${record.id}`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

const isRaw = (value: unknown, source: Source): boolean =>
  isObject(value) &&
  (source === "api" || Object.values(value).every((cell) => typeof cell === "string"));

// Checks a value parsed from a year file. `where` names the file and position, and leads
// every message, so a problem can be found without printing the record itself.
export const checkRecord = (value: unknown, where: string): ArchiveRecord => {
  const fail = (problem: string): never => {
    throw new ArchiveError(`${where}: ${problem}`);
  };
  if (!isObject(value)) return fail("is not an object");
  const { account, source, id, format, date, first_seen, revisions, raw } = value;
  if (!isText(account) || !ACCOUNT_KEY.test(account)) return fail("account is not a valid key");
  if (source !== "api" && source !== "import") return fail("source is neither api nor import");
  if (!isText(id)) return fail("id is missing");
  if (source === "import" && !isText(format)) return fail("format is missing");
  if (!isText(date) || !isIsoDate(date)) return fail("date is not a calendar date");
  if (!isText(first_seen) || !isTimestamp(first_seen)) return fail("first_seen is not a UTC time");
  if (!Array.isArray(revisions)) return fail("revisions is not a list");
  for (const revision of revisions as unknown[]) {
    if (
      !isObject(revision) ||
      !isText(revision.replaced_at) ||
      !isTimestamp(revision.replaced_at) ||
      !isRaw(revision.raw, source)
    ) {
      return fail("revisions holds something that is not a revision");
    }
  }
  if (!isRaw(raw, source)) return fail("raw is not what this source stores");
  return value as ArchiveRecord;
};
