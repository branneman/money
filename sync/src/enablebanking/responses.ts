import { isIsoDate, isObject, isText } from "@money/shared";
import type { Incoming } from "@money/shared";

import { SyncError } from "../errors.ts";
import { timestampOf } from "../time.ts";

// A response that is not what the code was written for. Nothing is guessed from it.
export class ResponseError extends SyncError {
  override name = "ResponseError";
}

export const isJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

// Node passes the reviver a third argument holding each primitive's source text.
const keepNumbersExact = (_key: string, value: unknown, context?: { source?: string }): unknown => {
  if (typeof value === "number" && JSON.stringify(value) !== context?.source) {
    throw new ResponseError("holds a number that would not survive being stored");
  }
  return value;
};

// Parses text, refusing any number that JSON would write back differently (1.10, an
// integer too large to hold). `raw` is compared with a copy that has been through JSON, so
// such a number would show as a revision on every later night.
export const parseExact = (text: string, where: string): unknown => {
  try {
    return JSON.parse(text, keepNumbersExact) as unknown;
  } catch (error) {
    if (error instanceof ResponseError) throw new ResponseError(`${where} ${error.message}`);
    // The parser's own message can quote the text.
    throw new ResponseError(`${where} is not valid JSON`);
  }
};

// Parses a response that is read and never stored: the list of banks, an authorisation, a
// session. The exact-number rule protects what is stored, and here it could only refuse an
// answer over a field nobody reads, in a session's case after the one-time code is spent.
export const parseJson = (text: string, where: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parser's own message can quote the text.
    throw new ResponseError(`${where} is not valid JSON`);
  }
};

export type Page = { transactions: readonly unknown[]; continuationKey: string | null };

export const checkPage = (value: unknown, where: string): Page => {
  if (!isObject(value)) throw new ResponseError(`${where} is not an object`);
  if (!Array.isArray(value.transactions)) {
    throw new ResponseError(`${where}: transactions is not a list`);
  }
  const key = value.continuation_key;
  if (key !== undefined && key !== null && !isText(key)) {
    throw new ResponseError(`${where}: continuation_key is not a text`);
  }
  return {
    transactions: value.transactions as unknown[],
    continuationKey: isText(key) ? key : null,
  };
};

// The booked transactions of a page, each with the identifier and booking date the archive
// files it under. Anything not booked is counted and left out. A booked transaction
// without its identifier or date stops the page: identity never falls back on content.
export const readTransactions = (
  page: Page,
  where: string,
): { booked: Incoming[]; skipped: number } => {
  const booked: Incoming[] = [];
  let skipped = 0;
  page.transactions.forEach((value, index) => {
    const at = `${where}, transaction ${index + 1}`;
    if (!isObject(value)) throw new ResponseError(`${at} is not an object`);
    if (!isText(value.status)) throw new ResponseError(`${at} has no status`);
    if (value.status !== "BOOK") {
      skipped += 1;
      return;
    }
    if (!isText(value.entry_reference)) {
      throw new ResponseError(`${at} is booked without an entry_reference`);
    }
    if (!isText(value.booking_date) || !isIsoDate(value.booking_date)) {
      throw new ResponseError(`${at} is booked without a usable booking_date`);
    }
    booked.push({ id: value.entry_reference, date: value.booking_date, raw: value });
  });
  return { booked, skipped };
};

export type Aspsp = {
  name: string;
  country: string;
  maximumConsentValidity: number;
  requiredPsuHeaders: string[];
};

const HEADER_NAME = /^[A-Za-z][A-Za-z-]*$/;

// The one bank asked for, from GET /aspsps. Other entries are not judged: an oddity in a
// bank nobody uses must not stop an authorisation.
export const findAspsp = (value: unknown, name: string, country: string): Aspsp | null => {
  if (!isObject(value) || !Array.isArray(value.aspsps)) {
    throw new ResponseError("the list of banks is not a list");
  }
  for (const [index, item] of (value.aspsps as unknown[]).entries()) {
    if (!isObject(item)) {
      throw new ResponseError(`the list of banks, entry ${index + 1} is not an object`);
    }
    if (item.name !== name || item.country !== country) continue;
    const validity = item.maximum_consent_validity;
    if (typeof validity !== "number" || !Number.isInteger(validity) || validity <= 0) {
      throw new ResponseError(
        "the bank's maximum_consent_validity is not a whole number of seconds",
      );
    }
    const headers: unknown = item.required_psu_headers ?? [];
    if (
      !Array.isArray(headers) ||
      !headers.every((header) => typeof header === "string" && HEADER_NAME.test(header))
    ) {
      throw new ResponseError("the bank's required_psu_headers is not a list of header names");
    }
    return {
      name,
      country,
      maximumConsentValidity: validity,
      requiredPsuHeaders: headers as string[],
    };
  }
  return null;
};

export const checkAuthStart = (value: unknown): { url: string } => {
  if (
    !isObject(value) ||
    !isText(value.url) ||
    !URL.canParse(value.url) ||
    new URL(value.url).protocol !== "https:"
  ) {
    throw new ResponseError("the authorisation has no https address to open");
  }
  return { url: value.url };
};

const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

// Date.parse guesses (no offset reads as the host local time, a bare year parses), so the
// shape is checked first.
const isTimestamp = (text: string): boolean =>
  RFC_3339.test(text) && isIsoDate(text.slice(0, 10)) && !Number.isNaN(Date.parse(text));

export type Session = {
  sessionId: string;
  validUntil: string;
  accounts: { iban: string | null; uid: string | null }[];
};

export const checkSession = (value: unknown): Session => {
  if (!isObject(value)) throw new ResponseError("the session is not an object");
  const sessionId = value.session_id;
  if (!isText(sessionId) || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
    throw new ResponseError("the session has no usable session_id");
  }
  const until = isObject(value.access) ? value.access.valid_until : undefined;
  if (!isText(until) || !isTimestamp(until)) {
    throw new ResponseError("the session has no usable access.valid_until");
  }
  if (!Array.isArray(value.accounts)) {
    throw new ResponseError("the session's accounts is not a list");
  }
  const accounts = (value.accounts as unknown[]).map((account, index) => {
    if (!isObject(account)) {
      throw new ResponseError(`the session's accounts, entry ${index + 1} is not an object`);
    }
    const id = account.account_id;
    return {
      iban: isObject(id) && isText(id.iban) ? id.iban : null,
      uid: isText(account.uid) ? account.uid : null,
    };
  });
  return { sessionId, validUntil: timestampOf(new Date(until)), accounts };
};
