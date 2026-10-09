import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aFormat,
  anApiRaw,
  anApiRecord,
  anImportRaw,
  anImportRecord,
} from "../../testing/factories.ts";
import { normalise, NormaliseError } from "./normalise.ts";

const FORMATS = { "example-export": aFormat() };

test("an API debit is negative, and its counterparty is the creditor", () => {
  assert.deepEqual(normalise(anApiRecord(), FORMATS), {
    account: "bnka-current",
    source: "api",
    id: "20250102-10000001",
    date: "2025-01-02",
    value_date: "2025-01-02",
    amount: -1234,
    currency: "EUR",
    counterparty_name: "Example Shop",
    counterparty_account: "NL00BNKC0000000009",
    description: "Line one\nLine two",
    code: "CARD",
    original_amount: null,
    original_currency: null,
    first_seen: "2025-01-03T03:00:00Z",
    revised: false,
  });
});

test("an API credit is positive, and its counterparty is the debtor", () => {
  const raw = anApiRaw({
    credit_debit_indicator: "CRDT",
    debtor: { name: "Employer" },
    debtor_account: { iban: "NL00BNKD0000000005" },
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.amount, 1234);
  assert.equal(result.counterparty_name, "Employer");
  assert.equal(result.counterparty_account, "NL00BNKD0000000005");
});

test("an API record with only the guaranteed fields normalises to nulls", () => {
  const raw = {
    transaction_amount: { currency: "EUR", amount: "5.00" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
  };
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.amount, -500);
  assert.equal(result.value_date, null);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.counterparty_account, null);
  assert.equal(result.description, "");
  assert.equal(result.code, null);
});

test("explicit nulls are treated like absent fields", () => {
  const raw = anApiRaw({
    creditor: null,
    creditor_account: null,
    remittance_information: null,
    bank_transaction_code: null,
    value_date: null,
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.description, "");
});

test("a counterparty account without an IBAN falls back to its other identification", () => {
  const raw = anApiRaw({ creditor_account: { other: { identification: "12345678" } } });
  assert.equal(normalise(anApiRecord({ raw }), FORMATS).counterparty_account, "12345678");
});

test("the code falls back to the bank's description of it", () => {
  const raw = anApiRaw({ bank_transaction_code: { description: "Card payment" } });
  assert.equal(normalise(anApiRecord({ raw }), FORMATS).code, "Card payment");
});

test("a purchase in another currency carries the original amount, signed like the amount", () => {
  const raw = anApiRaw({
    exchange_rate: {
      unit_currency: "EUR",
      exchange_rate: "160.0",
      instructed_amount: { currency: "JPY", amount: "1500" },
    },
  });
  const result = normalise(anApiRecord({ raw }), FORMATS);
  assert.equal(result.original_amount, -1500);
  assert.equal(result.original_currency, "JPY");
});

test("a record with revisions is marked revised", () => {
  const record = anApiRecord({
    revisions: [{ replaced_at: "2025-01-04T03:00:00Z", raw: anApiRaw() }],
  });
  assert.equal(normalise(record, FORMATS).revised, true);
});

test("the date is the record's date, not re-read from raw", () => {
  const record = anApiRecord({ date: "2025-01-05", raw: anApiRaw({ booking_date: "2025-01-02" }) });
  assert.equal(normalise(record, FORMATS).date, "2025-01-05");
});

test("an import row is read through its format", () => {
  assert.deepEqual(normalise(anImportRecord(), FORMATS), {
    account: "bnka-current",
    source: "import",
    id: "000000000000000001",
    date: "2025-01-02",
    value_date: "2025-01-02",
    amount: -1234,
    currency: "EUR",
    counterparty_name: "Example Shop",
    counterparty_account: "NL00BNKC0000000009",
    description: "Line one\nLine two",
    code: "card",
    original_amount: null,
    original_currency: null,
    first_seen: "2025-04-02T19:00:00Z",
    revised: false,
  });
});

test("an import row with empty optional cells gives nulls", () => {
  const raw = anImportRaw({
    Counterparty: "",
    "Counterparty account": "",
    Type: "",
    "Value date": "",
    "Text 1": "",
    "Text 2": "",
  });
  const result = normalise(anImportRecord({ raw }), FORMATS);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.counterparty_account, null);
  assert.equal(result.code, null);
  assert.equal(result.value_date, null);
  assert.equal(result.description, "");
});

test("a format without optional columns gives nulls for them", () => {
  const formats = {
    "example-export": aFormat({
      value_date: undefined,
      counterparty_name: undefined,
      counterparty_account: undefined,
      description: undefined,
      code: undefined,
      original_amount: undefined,
      original_currency: undefined,
    }),
  };
  const result = normalise(anImportRecord(), formats);
  assert.equal(result.counterparty_name, null);
  assert.equal(result.description, "");
  assert.equal(result.original_amount, null);
});

test("an imported foreign purchase carries the original amount, signed like the amount", () => {
  const raw = anImportRaw({ "Original amount": "74,50", "Original currency": "DKK" });
  const result = normalise(anImportRecord({ raw }), FORMATS);
  assert.equal(result.original_amount, -7450);
  assert.equal(result.original_currency, "DKK");
});

const unreadable: [string, () => unknown, RegExp][] = [
  [
    "an API record without a currency",
    () =>
      normalise(
        anApiRecord({ raw: anApiRaw({ transaction_amount: { amount: "1.00" } }) }),
        FORMATS,
      ),
    /currency/,
  ],
  [
    "an API record with an unreadable amount",
    () =>
      normalise(
        anApiRecord({
          raw: anApiRaw({ transaction_amount: { currency: "EUR", amount: "1.234,56" } }),
        }),
        FORMATS,
      ),
    /amount/,
  ],
  [
    "an API record with a signed amount",
    () =>
      normalise(
        anApiRecord({
          raw: anApiRaw({ transaction_amount: { currency: "EUR", amount: "-1.00" } }),
        }),
        FORMATS,
      ),
    /amount/,
  ],
  [
    "an API record without a direction",
    () => normalise(anApiRecord({ raw: anApiRaw({ credit_debit_indicator: undefined }) }), FORMATS),
    /direction/,
  ],
  [
    "an import record of an unknown format",
    () => normalise(anImportRecord({ format: "gone" }), FORMATS),
    /format gone is not configured/,
  ],
  [
    "an import row with an unreadable amount",
    () => normalise(anImportRecord({ raw: anImportRaw({ Amount: "1.234,56" }) }), FORMATS),
    /amount/,
  ],
  [
    "an import row without a currency",
    () => normalise(anImportRecord({ raw: anImportRaw({ Currency: "" }) }), FORMATS),
    /currency/,
  ],
  [
    "an import row with an unreadable value date",
    () => normalise(anImportRecord({ raw: anImportRaw({ "Value date": "02-01-2025" }) }), FORMATS),
    /value date/,
  ],
];

for (const [name, act, message] of unreadable) {
  test(`${name} is an error that names the record and nothing private`, () => {
    assert.throws(act, (error: unknown) => {
      assert.ok(error instanceof NormaliseError);
      assert.match(error.message, message);
      assert.match(error.message, /^bnka-current\/(api|import)\//);
      assert.ok(!/Example Shop|NL00|12[.,]34|1\.234/.test(error.message), error.message);
      return true;
    });
  });
}
