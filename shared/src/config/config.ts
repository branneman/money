import { ACCOUNT_KEY } from "../archive/record.ts";
import { DATE_FORMATS } from "../util/dates.ts";
import type { DateFormat } from "../util/dates.ts";

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value !== "";
const isColumn = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && isText(value.column);

const formatProblems = (format: unknown): string[] => {
  if (!isObject(format)) return ["is not an object"];
  const problems: string[] = [];
  const column = (name: string, required: boolean): void => {
    if (format[name] === undefined ? required : !isColumn(format[name])) {
      problems.push(`${name} must name a column`);
    }
  };
  const dated = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else if (!isText(value.format) || !Object.hasOwn(DATE_FORMATS, value.format)) {
      problems.push(`${name}.format must be one of ${Object.keys(DATE_FORMATS).join(", ")}`);
    }
  };
  const amount = (name: string, required: boolean): void => {
    const value = format[name];
    if (value === undefined && !required) return;
    if (!isColumn(value)) problems.push(`${name} must name a column`);
    else if (value.decimal !== "." && value.decimal !== ",") {
      problems.push(`${name}.decimal must be a point or a comma`);
    }
  };

  if (typeof format.delimiter !== "string" || format.delimiter.length !== 1) {
    problems.push("delimiter must be a single character");
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
    }
  }
  return problems;
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

  for (const [index, [key, bank]] of Object.entries(banks).entries()) {
    const at = labelOf("banks", key, index);
    problems.push(...keyProblem(at, key));
    const aspsp = isObject(bank) && isObject(bank.aspsp) ? bank.aspsp : {};
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
      const identifier = account[field];
      if (!isText(identifier)) continue;
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
