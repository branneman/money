import type { ImportFormat } from "../config/config.ts";
import { parseAmount } from "../util/amounts.ts";
import { isIsoDate, parseDate } from "../util/dates.ts";
import { isObject, isText } from "../util/guards.ts";
import { identityOf } from "./record.ts";
import type { ApiRecord, ArchiveRecord, ImportRecord, Source } from "./record.ts";

// What every reader works on. `raw` is never interpreted anywhere but in this file.
export type Transaction = {
  account: string;
  source: Source;
  id: string;
  date: string;
  value_date: string | null;
  amount: number;
  currency: string;
  counterparty_name: string | null;
  counterparty_account: string | null;
  description: string;
  code: string | null;
  original_amount: number | null;
  original_currency: string | null;
  first_seen: string;
  revised: boolean;
};

export class NormaliseError extends Error {
  override name = "NormaliseError";
}

// Messages name the record and the field. They never repeat a value from `raw`.
const failure = (record: ArchiveRecord, problem: string): NormaliseError =>
  new NormaliseError(`${identityOf(record)} ${problem}`);

const text = (value: unknown): string | null => (isText(value) ? value : null);

const object = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

const CURRENCY_CODE = /^[A-Z]{3}$/;

// The API's amounts carry no sign: the direction is a separate field.
const unsignedAmount = (value: unknown, currency: string): number | null => {
  const amount = text(value);
  return amount === null || /^[+-]/.test(amount) ? null : parseAmount(amount, ".", currency);
};

// An original amount and an original currency come together or not at all.
const checkPaired = (record: ArchiveRecord, hasAmount: boolean, hasCurrency: boolean): void => {
  if (hasAmount && !hasCurrency) throw failure(record, "has an original amount without a currency");
  if (hasCurrency && !hasAmount)
    throw failure(record, "has an original currency without an amount");
};

const withSign = (magnitude: number, like: number): number =>
  like < 0 && magnitude !== 0 ? -Math.abs(magnitude) : Math.abs(magnitude);

const common = (record: ArchiveRecord) => ({
  account: record.account,
  source: record.source,
  id: record.id,
  date: record.date,
});

const normaliseApi = (record: ApiRecord): Transaction => {
  const { raw } = record;
  const money = object(raw.transaction_amount);
  const currency = text(money.currency);
  if (currency === null) throw failure(record, "has no currency");
  if (!CURRENCY_CODE.test(currency)) throw failure(record, "has a currency that cannot be read");
  const magnitude = unsignedAmount(money.amount, currency);
  if (magnitude === null) throw failure(record, "has an amount that cannot be read");
  const indicator = raw.credit_debit_indicator;
  if (indicator !== "CRDT" && indicator !== "DBIT") throw failure(record, "has no direction");
  const amount = withSign(magnitude, indicator === "DBIT" ? -1 : 1);

  const party = object(indicator === "DBIT" ? raw.creditor : raw.debtor);
  const partyAccount = object(indicator === "DBIT" ? raw.creditor_account : raw.debtor_account);
  const code = object(raw.bank_transaction_code);
  const instructed = object(object(raw.exchange_rate).instructed_amount);
  const originalCurrency = text(instructed.currency);
  // An amount of the wrong type is present, and is then an amount that cannot be read.
  const hasOriginal =
    instructed.amount !== undefined && instructed.amount !== null && instructed.amount !== "";
  checkPaired(record, hasOriginal, originalCurrency !== null);
  if (originalCurrency !== null && !CURRENCY_CODE.test(originalCurrency)) {
    throw failure(record, "has an original currency that cannot be read");
  }
  const original =
    originalCurrency === null ? null : unsignedAmount(instructed.amount, originalCurrency);
  if (originalCurrency !== null && original === null) {
    throw failure(record, "has an original amount that cannot be read");
  }
  const valueDate = text(raw.value_date);
  if (valueDate !== null && !isIsoDate(valueDate)) {
    throw failure(record, "has a value date that cannot be read");
  }
  const lines = Array.isArray(raw.remittance_information)
    ? (raw.remittance_information as unknown[]).filter((line) => text(line) !== null)
    : [];

  return {
    ...common(record),
    value_date: valueDate,
    amount,
    currency,
    counterparty_name: text(party.name),
    counterparty_account:
      text(partyAccount.iban) ?? text(object(partyAccount.other).identification),
    description: lines.join("\n"),
    code: text(code.code) ?? text(code.description),
    original_amount: original === null ? null : withSign(original, amount),
    original_currency: original === null ? null : originalCurrency,
    first_seen: record.first_seen,
    revised: record.revisions.length > 0,
  };
};

const normaliseImport = (record: ImportRecord, format: ImportFormat): Transaction => {
  const cell = (column: { column: string } | undefined): string | null =>
    column === undefined ? null : text(record.raw[column.column]);

  const currency = cell(format.currency);
  if (currency === null) throw failure(record, "has no currency");
  if (!CURRENCY_CODE.test(currency)) throw failure(record, "has a currency that cannot be read");
  const amount = parseAmount(cell(format.amount) ?? "", format.amount.decimal, currency);
  if (amount === null) throw failure(record, "has an amount that cannot be read");

  const valueDateText = cell(format.value_date);
  const valueDate =
    valueDateText === null || format.value_date === undefined
      ? null
      : parseDate(valueDateText, format.value_date.format);
  if (valueDateText !== null && valueDate === null) {
    throw failure(record, "has a value date that cannot be read");
  }

  const originalCurrency = cell(format.original_currency);
  const originalText = cell(format.original_amount);
  checkPaired(record, originalText !== null, originalCurrency !== null);
  if (originalCurrency !== null && !CURRENCY_CODE.test(originalCurrency)) {
    throw failure(record, "has an original currency that cannot be read");
  }
  const original =
    originalCurrency === null || originalText === null || format.original_amount === undefined
      ? null
      : parseAmount(originalText, format.original_amount.decimal, originalCurrency);
  if (originalCurrency !== null && originalText !== null && original === null) {
    throw failure(record, "has an original amount that cannot be read");
  }

  return {
    ...common(record),
    value_date: valueDate,
    amount,
    currency,
    counterparty_name: cell(format.counterparty_name),
    counterparty_account: cell(format.counterparty_account),
    description: (format.description?.columns ?? [])
      .map((column) => text(Object.hasOwn(record.raw, column) ? record.raw[column] : null))
      .filter((line) => line !== null)
      .join("\n"),
    code: cell(format.code),
    original_amount: original === null ? null : withSign(original, amount),
    original_currency: original === null ? null : originalCurrency,
    first_seen: record.first_seen,
    revised: record.revisions.length > 0,
  };
};

export const normalise = (
  record: ArchiveRecord,
  formats: Readonly<Record<string, ImportFormat>>,
): Transaction => {
  if (record.source === "api") return normaliseApi(record);
  if (!Object.hasOwn(formats, record.format)) {
    throw failure(
      record,
      `is of import format ${record.format}, but format ${record.format} is not configured`,
    );
  }
  return normaliseImport(record, formats[record.format]);
};
