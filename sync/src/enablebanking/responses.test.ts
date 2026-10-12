import assert from "node:assert/strict";
import { test } from "node:test";

import { anApiRaw } from "@money/shared/testing";

import {
  checkAuthStart,
  checkPage,
  checkSession,
  findAspsp,
  isJson,
  parseExact,
  readTransactions,
  ResponseError,
} from "./responses.ts";

const refused = (work: () => unknown, message: string): void => {
  assert.throws(work, (error: unknown) => {
    assert.ok(error instanceof ResponseError);
    assert.equal(error.message, message);
    return true;
  });
};

test("text is JSON or it is not", () => {
  assert.equal(isJson('{"transactions":[]}'), true);
  assert.equal(isJson("<html>Bad gateway</html>"), false);
  assert.equal(isJson(""), false);
});

test("exact parsing returns what JSON holds", () => {
  assert.deepEqual(parseExact('{"a":[1,2.5,"1.10",null,true]}', "page 1"), {
    a: [1, 2.5, "1.10", null, true],
  });
});

test("text that is not JSON is refused without quoting it", () => {
  refused(() => parseExact('{"iban": NL00BNKA0000000001', "page 1"), "page 1 is not valid JSON");
});

// A stored copy has been through JSON. A number that JSON writes back differently would
// read as a change on every later night.
test("a number that would not survive being stored is refused", () => {
  for (const text of ['{"a":1.10}', '{"a":12345678901234567890}', '{"a":1e2}', '{"a":-0}']) {
    refused(
      () => parseExact(text, "page 1"),
      "page 1 holds a number that would not survive being stored",
    );
  }
});

test("a page is a list of transactions and perhaps a key for the next page", () => {
  assert.deepEqual(checkPage({ transactions: [], continuation_key: "next" }, "page 1"), {
    transactions: [],
    continuationKey: "next",
  });
  assert.equal(checkPage({ transactions: [] }, "page 1").continuationKey, null);
  assert.equal(
    checkPage({ transactions: [], continuation_key: null }, "page 1").continuationKey,
    null,
  );
});

test("a page of another shape is refused", () => {
  refused(() => checkPage([], "page 1"), "page 1 is not an object");
  refused(() => checkPage({}, "page 1"), "page 1: transactions is not a list");
  refused(() => checkPage({ transactions: {} }, "page 1"), "page 1: transactions is not a list");
  for (const key of ["", 7, {}]) {
    refused(
      () => checkPage({ transactions: [], continuation_key: key }, "page 1"),
      "page 1: continuation_key is not a text",
    );
  }
});

const page = (...transactions: unknown[]) => ({ transactions, continuationKey: null });

test("a booked transaction is read with its identifier and booking date, and kept whole", () => {
  const raw = anApiRaw({ entry_reference: "ref-1", booking_date: "2026-10-06" });
  assert.deepEqual(readTransactions(page(raw), "page 1"), {
    booked: [{ id: "ref-1", date: "2026-10-06", raw }],
    skipped: 0,
  });
});

test("a transaction that is not booked is skipped and counted, whatever it lacks", () => {
  const pending = { status: "PDNG", transaction_amount: { currency: "EUR", amount: "1.00" } };
  const result = readTransactions(page(pending, anApiRaw(), { status: "HOLD" }), "page 1");
  assert.equal(result.booked.length, 1);
  assert.equal(result.skipped, 2);
});

test("a transaction of an unexpected shape stops the page, naming its position", () => {
  refused(
    () => readTransactions(page(anApiRaw(), "text"), "page 2"),
    "page 2, transaction 2 is not an object",
  );
  refused(
    () => readTransactions(page(anApiRaw({ status: undefined })), "page 2"),
    "page 2, transaction 1 has no status",
  );
  for (const reference of [undefined, null, "", 12345]) {
    refused(
      () => readTransactions(page(anApiRaw({ entry_reference: reference })), "page 2"),
      "page 2, transaction 1 is booked without an entry_reference",
    );
  }
  for (const date of [undefined, null, 20261006, "06-10-2026", "2026-02-30"]) {
    refused(
      () => readTransactions(page(anApiRaw({ booking_date: date })), "page 2"),
      "page 2, transaction 1 is booked without a usable booking_date",
    );
  }
});

const listed = (overrides: Record<string, unknown> = {}) => ({
  name: "Example Bank",
  country: "NL",
  maximum_consent_validity: 15_552_000,
  required_psu_headers: ["Psu-Ip-Address"],
  ...overrides,
});

test("a bank is found by its exact name and country", () => {
  const value = { aspsps: [listed({ name: "Other Example Bank" }), listed()] };
  assert.deepEqual(findAspsp(value, "Example Bank", "NL"), {
    name: "Example Bank",
    country: "NL",
    maximumConsentValidity: 15_552_000,
    requiredPsuHeaders: ["Psu-Ip-Address"],
  });
  assert.equal(findAspsp(value, "example bank", "NL"), null);
  assert.equal(findAspsp(value, "Example Bank", "BE"), null);
});

test("required headers may be absent, and only the bank asked for is checked", () => {
  const odd = { name: "Other Example Bank", country: "NL" };
  const value = { aspsps: [odd, listed({ required_psu_headers: null })] };
  assert.deepEqual(findAspsp(value, "Example Bank", "NL")?.requiredPsuHeaders, []);
});

test("a list of banks of an unexpected shape is refused", () => {
  refused(() => findAspsp({}, "Example Bank", "NL"), "the list of banks is not a list");
  refused(
    () => findAspsp({ aspsps: ["x"] }, "Example Bank", "NL"),
    "the list of banks, entry 1 is not an object",
  );
  for (const validity of [undefined, "15552000", 0, 1.5]) {
    refused(
      () =>
        findAspsp(
          { aspsps: [listed({ maximum_consent_validity: validity })] },
          "Example Bank",
          "NL",
        ),
      "the bank's maximum_consent_validity is not a whole number of seconds",
    );
  }
  for (const headers of ["Psu-Ip-Address", [7], ["Not a header name"]]) {
    refused(
      () =>
        findAspsp({ aspsps: [listed({ required_psu_headers: headers })] }, "Example Bank", "NL"),
      "the bank's required_psu_headers is not a list of header names",
    );
  }
});

test("starting an authorisation gives an https address", () => {
  assert.deepEqual(checkAuthStart({ url: "https://bank.example/approve?authorization=1" }), {
    url: "https://bank.example/approve?authorization=1",
  });
  for (const value of [
    {},
    { url: 7 },
    { url: "not an address" },
    { url: "http://bank.example/" },
  ]) {
    refused(() => checkAuthStart(value), "the authorisation has no https address to open");
  }
});

const session = (overrides: Record<string, unknown> = {}) => ({
  session_id: "00000000-0000-4000-8000-000000000001",
  access: { valid_until: "2027-04-09T10:00:00Z" },
  accounts: [
    { account_id: { iban: "NL00BNKA0000000001" }, uid: "00000000-0000-4000-8000-000000000002" },
  ],
  ...overrides,
});

test("a session is read with its expiry and each account's IBAN and uid", () => {
  assert.deepEqual(checkSession(session()), {
    sessionId: "00000000-0000-4000-8000-000000000001",
    validUntil: "2027-04-09T10:00:00Z",
    accounts: [{ iban: "NL00BNKA0000000001", uid: "00000000-0000-4000-8000-000000000002" }],
  });
});

// The archive and the state hold one notation. The API may use another.
test("an expiry with a fraction or an offset is stored as a whole-second UTC timestamp", () => {
  const until = (text: string): string =>
    checkSession(session({ access: { valid_until: text } })).validUntil;
  assert.equal(until("2027-04-09T10:00:00.123456Z"), "2027-04-09T10:00:00Z");
  assert.equal(until("2027-04-09T12:00:00+02:00"), "2027-04-09T10:00:00Z");
  assert.equal(until("2027-04-09T10:00:00.000000+00:00"), "2027-04-09T10:00:00Z");
});

test("an account without an IBAN or a uid is kept, with null for what it lacks", () => {
  const accounts = [{ account_id: { other: { identification: "1001" } } }, { uid: "u" }];
  assert.deepEqual(checkSession(session({ accounts })).accounts, [
    { iban: null, uid: null },
    { iban: null, uid: "u" },
  ]);
});

test("a session of an unexpected shape is refused", () => {
  refused(() => checkSession([]), "the session is not an object");
  refused(
    () => checkSession(session({ session_id: undefined })),
    "the session has no usable session_id",
  );
  refused(
    () => checkSession(session({ session_id: "has spaces in it" })),
    "the session has no usable session_id",
  );
  refused(
    () => checkSession(session({ access: {} })),
    "the session has no usable access.valid_until",
  );
  refused(
    () => checkSession(session({ access: { valid_until: "next spring" } })),
    "the session has no usable access.valid_until",
  );
  refused(() => checkSession(session({ accounts: {} })), "the session's accounts is not a list");
  refused(
    () => checkSession(session({ accounts: ["x"] })),
    "the session's accounts, entry 1 is not an object",
  );
});
