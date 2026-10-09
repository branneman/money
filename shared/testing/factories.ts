import type { Incoming } from "../src/archive/merge.ts";
import type { ApiRaw, ApiRecord, ImportRaw, ImportRecord } from "../src/archive/record.ts";

// Everything here is invented. IBANs use check digits 00, which no real IBAN can have.

export const anApiRaw = (overrides: Record<string, unknown> = {}): ApiRaw => ({
  entry_reference: "20250102-10000001",
  transaction_amount: { currency: "EUR", amount: "12.34" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2025-01-02",
  value_date: "2025-01-02",
  creditor: { name: "Example Shop" },
  creditor_account: { iban: "NL00BNKC0000000009" },
  debtor: { name: "A. Holder" },
  debtor_account: { iban: "NL00BNKA0000000001" },
  bank_transaction_code: { description: "Card payment", code: "CARD", sub_code: null },
  remittance_information: ["Line one", "Line two"],
  ...overrides,
});

export const anImportRaw = (overrides: Record<string, string> = {}): ImportRaw => ({
  Account: "NL00BNKA0000000001",
  Currency: "EUR",
  Sequence: "000000000000000001",
  Booked: "2025-01-02",
  "Value date": "2025-01-02",
  Amount: "-12,34",
  "Counterparty account": "NL00BNKC0000000009",
  Counterparty: "Example Shop",
  Type: "card",
  "Text 1": "Line one",
  "Text 2": "Line two",
  "Text 3": "",
  "Original amount": "",
  "Original currency": "",
  ...overrides,
});

export const anApiRecord = (overrides: Partial<ApiRecord> = {}): ApiRecord => ({
  account: "bnka-current",
  source: "api",
  id: "20250102-10000001",
  date: "2025-01-02",
  first_seen: "2025-01-03T03:00:00Z",
  revisions: [],
  raw: anApiRaw(),
  ...overrides,
});

export const anImportRecord = (overrides: Partial<ImportRecord> = {}): ImportRecord => ({
  account: "bnka-current",
  source: "import",
  id: "000000000000000001",
  format: "example-export",
  date: "2025-01-02",
  first_seen: "2025-04-02T19:00:00Z",
  revisions: [],
  raw: anImportRaw(),
  ...overrides,
});

export const anIncoming = (overrides: Partial<Incoming> = {}): Incoming => ({
  id: "20250102-10000001",
  date: "2025-01-02",
  raw: anApiRaw(),
  ...overrides,
});
