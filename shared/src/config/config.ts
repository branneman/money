import { ACCOUNT_KEY } from "../archive/record.ts";
import { DATE_FORMATS } from "../util/dates.ts";
import type { DateFormat } from "../util/dates.ts";
import { isObject, isText } from "../util/guards.ts";
import { plainIban } from "../util/iban.ts";

export const ENCODINGS = ["utf-8", "windows-1252", "iso-8859-15"] as const;

export type Column = { column: string };
export type DateColumn = { column: string; format: DateFormat };
export type AmountColumn = { column: string; decimal: "." | "," };

export type ImportFormat = {
  delimiter: string;
  encoding: (typeof ENCODINGS)[number];
  account: Column;
  id: Column;
  date: DateColumn;
  amount: AmountColumn;
  currency: Column;
  value_date?: DateColumn;
  counterparty_name?: Column;
  counterparty_account?: Column;
  description?: { columns: string[] };
  code?: Column;
  original_amount?: AmountColumn;
  original_currency?: Column;
};

export type Account = { bank: string; iban?: string; import_id?: string; closed?: boolean };

export type Config = {
  banks: Record<string, { aspsp: { name: string; country: string } }>;
  accounts: Record<string, Account>;
  imports: Record<string, ImportFormat>;
};

export type ConfigResult = { ok: true; config: Config } | { ok: false; problems: string[] };

const isColumn = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && isText(value.column);

// A field name that may be repeated in a message: letters and underscores only, so it can
// never be an account number typed where a field belongs.
const FIELD_NAME = /^[a-z][a-z_]*$/;

// One problem for each key of `value` that is not in `known`.
const unknownFields = (
  value: Record<string, unknown>,
  known: readonly string[],
  kind = "field",
): string[] =>
  Object.keys(value)
    .filter((key) => !known.includes(key))
    .map((key) =>
      FIELD_NAME.test(key)
        ? `${key} is not a ${kind} the configuration knows`
        : `holds a ${kind} the configuration does not know`,
    );

const SINGLE_COLUMNS = [
  "account",
  "id",
  "date",
  "amount",
  "currency",
  "value_date",
  "counterparty_name",
  "counterparty_account",
  "code",
  "original_amount",
  "original_currency",
] as const;

const FORMAT_FIELDS = ["delimiter", "encoding", ...SINGLE_COLUMNS, "description"];

// Every column a format reads, with the field that reads it.
export const namedColumns = (format: ImportFormat): [field: string, column: string][] => [
  ...SINGLE_COLUMNS.flatMap((field): [string, string][] => {
    const named = format[field];
    return named === undefined ? [] : [[field, named.column]];
  }),
  ...(format.description?.columns ?? []).map((column, index): [string, string] => [
    `description, column ${index + 1}`,
    column,
  ]),
];

const formatProblems = (format: unknown): string[] => {
  if (!isObject(format)) return ["is not an object"];
  const problems: string[] = unknownFields(format, FORMAT_FIELDS);
  const within = (name: string, value: Record<string, unknown>, known: readonly string[]): void => {
    problems.push(...unknownFields(value, known).map((problem) => `${name}: ${problem}`));
  };
  const column = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else within(name, value, ["column"]);
  };
  const dated = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else {
      within(name, value, ["column", "format"]);
      if (!isText(value.format) || !Object.hasOwn(DATE_FORMATS, value.format)) {
        problems.push(`${name}.format must be one of ${Object.keys(DATE_FORMATS).join(", ")}`);
      }
    }
  };
  const amount = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else {
      within(name, value, ["column", "decimal"]);
      if (value.decimal !== "." && value.decimal !== ",") {
        problems.push(`${name}.decimal must be a point or a comma`);
      }
    }
  };

  if (typeof format.delimiter !== "string" || format.delimiter.length !== 1) {
    problems.push("delimiter must be a single character");
  } else if (['"', "\r", "\n"].includes(format.delimiter)) {
    problems.push("delimiter may not be a double quote or a line ending");
  }
  if (!ENCODINGS.includes(format.encoding as (typeof ENCODINGS)[number])) {
    problems.push(`encoding must be one of ${ENCODINGS.join(", ")}`);
  }
  column("account", true);
  column("id", true);
  dated("date", true);
  amount("amount", true);
  column("currency", true);
  dated("value_date", false);
  column("counterparty_name", false);
  column("counterparty_account", false);
  column("code", false);
  amount("original_amount", false);
  column("original_currency", false);
  if (format.description !== undefined) {
    const columns = isObject(format.description) ? format.description.columns : undefined;
    if (!Array.isArray(columns) || columns.length === 0 || !columns.every(isText)) {
      problems.push("description must list at least one column");
    } else if (isObject(format.description)) {
      within("description", format.description, ["columns"]);
    }
  }
  if (problems.length > 0) return problems;

  // Identifiers appear in messages, so the identifier may be nothing else the format reads.
  const sound = format as unknown as ImportFormat;
  return namedColumns(sound)
    .filter(([field, name]) => field !== "id" && name === sound.id.column)
    .map(([field]) => `id names the same column as ${field}`);
};

// Names an entry by its key only when the key is well formed. A malformed key may be
// anything a person pasted, so it is named by position instead.
const labelOf = (section: string, key: string, index: number): string =>
  ACCOUNT_KEY.test(key) ? `${section}.${key}` : `${section}, entry ${index + 1}`;

const keyProblem = (label: string, key: string): string[] =>
  ACCOUNT_KEY.test(key) ? [] : [`${label}: the key may hold only a-z, 0-9 and -`];

// Returns every problem, each as a sentence a person can act on. Messages name keys and
// fields, never the values of account numbers.
export const validateConfig = (value: unknown): ConfigResult => {
  if (!isObject(value)) return { ok: false, problems: ["the configuration is not a JSON object"] };
  const problems: string[] = [];
  const section = (name: string): Record<string, unknown> => {
    if (isObject(value[name])) return value[name];
    problems.push(`${name} is missing or is not an object`);
    return {};
  };
  const banks = section("banks");
  const accounts = section("accounts");
  const imports = section("imports");
  problems.push(...unknownFields(value, ["banks", "accounts", "imports"], "section"));

  for (const [index, [key, bank]] of Object.entries(banks).entries()) {
    const at = labelOf("banks", key, index);
    problems.push(...keyProblem(at, key));
    const aspsp = isObject(bank) && isObject(bank.aspsp) ? bank.aspsp : {};
    if (isObject(bank)) {
      problems.push(...unknownFields(bank, ["aspsp"]).map((problem) => `${at}: ${problem}`));
    }
    problems.push(
      ...unknownFields(aspsp, ["name", "country"]).map((problem) => `${at}: aspsp: ${problem}`),
    );
    if (!isText(aspsp.name)) problems.push(`${at}: aspsp.name is missing`);
    if (!isText(aspsp.country) || !/^[A-Z]{2}$/.test(aspsp.country)) {
      problems.push(`${at}: aspsp.country must be a two-letter country code`);
    }
  }

  const ibans = new Map<string, string>();
  const importIds = new Map<string, string>();
  for (const [index, [key, account]] of Object.entries(accounts).entries()) {
    const at = labelOf("accounts", key, index);
    problems.push(...keyProblem(at, key));
    if (!isObject(account)) {
      problems.push(`${at}: is not an object`);
      continue;
    }
    problems.push(
      ...unknownFields(account, ["bank", "iban", "import_id", "closed"]).map(
        (problem) => `${at}: ${problem}`,
      ),
    );
    if (!isText(account.bank)) problems.push(`${at}: bank is missing`);
    else if (!Object.hasOwn(banks, account.bank)) {
      problems.push(`${at}: its bank is not configured`);
    }
    if (!isText(account.iban) && !isText(account.import_id)) {
      problems.push(`${at}: needs an iban or an import_id`);
    }
    if (account.closed !== undefined && typeof account.closed !== "boolean") {
      problems.push(`${at}: closed must be true or false`);
    }
    for (const field of ["iban", "import_id"] as const) {
      if (account[field] !== undefined && !isText(account[field])) {
        problems.push(`${at}: ${field} must be a non-empty text`);
      }
    }
    for (const [field, seen] of [
      ["iban", ibans],
      ["import_id", importIds],
    ] as const) {
      const written = account[field];
      if (!isText(written)) continue;
      // An IBAN is matched whatever its spacing and case, so it is compared that way here:
      // two spellings of one IBAN would otherwise be two accounts for one row.
      const identifier = field === "iban" ? plainIban(written) : written;
      const other = seen.get(identifier);
      if (other !== undefined) problems.push(`${at}: shares its ${field} with ${other}`);
      else seen.set(identifier, at);
    }
  }

  for (const [index, [key, format]] of Object.entries(imports).entries()) {
    const at = labelOf("imports", key, index);
    problems.push(...keyProblem(at, key));
    problems.push(...formatProblems(format).map((problem) => `${at}: ${problem}`));
  }

  return problems.length === 0 ? { ok: true, config: value as Config } : { ok: false, problems };
};
