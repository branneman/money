// Which accounts the invented household has, and how each one reaches the archive.
// Two made-up banks. Everything here is invented; every IBAN has check digits 00.
import type { Config, ImportFormat } from "@money/shared";

import { iso, parts, utcDay } from "./dates.ts";

// A second bank is added on this day. The joint account, its savings and the card move to
// bnkb and their bnka accounts are closed; the personal account stays at bnka.
export const SWITCH = utcDay(2026, 4, 1);

export const ROLES = [
  "personal",
  "joint",
  "personal-savings",
  "joint-savings",
  "card",
  "second-personal",
  "second-savings",
] as const;
export type Role = (typeof ROLES)[number];

export type AccountKey =
  | "bnka-personal"
  | "bnka-joint"
  | "bnka-personal-savings"
  | "bnka-joint-savings"
  | "bnka-card"
  | "bnkb-personal"
  | "bnkb-joint"
  | "bnkb-personal-savings"
  | "bnkb-joint-savings"
  | "bnkb-card";

type FormatKey = "account-export" | "card-export";

// `api`: fetched nightly from `firstSync`, reaching back to `from`.
// `history`: one export, imported once, covering everything up to HISTORY_UNTIL.
// `ongoing`: the API cannot reach this account, so it is exported every quarter.
type Reach = {
  api?: { from: number; firstSync: number };
  import?: "history" | "ongoing";
};

export type AccountInfo = {
  bank: "bnka" | "bnkb";
  holder: string;
  iban?: string;
  import_id?: string;
  closed?: true;
  format: FormatKey;
  reach: Reach;
};

const SOLO = "M. Visser";
const JOINT = "M. Visser en/of T. Bakker";
const BNKA_API = { from: utcDay(2025, 1, 1), firstSync: utcDay(2025, 4, 1) };
const BNKB_API = { from: SWITCH, firstSync: SWITCH };
const ACCOUNT = "account-export";

export const ACCOUNTS: Record<AccountKey, AccountInfo> = {
  "bnka-personal": {
    bank: "bnka",
    holder: SOLO,
    iban: "NL00BNKA0000000001",
    format: ACCOUNT,
    reach: { api: BNKA_API, import: "history" },
  },
  "bnka-joint": {
    bank: "bnka",
    holder: JOINT,
    iban: "NL00BNKA0000000002",
    closed: true,
    format: ACCOUNT,
    reach: { api: BNKA_API, import: "history" },
  },
  "bnka-personal-savings": {
    bank: "bnka",
    holder: SOLO,
    iban: "NL00BNKA0000000003",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnka-joint-savings": {
    bank: "bnka",
    holder: JOINT,
    iban: "NL00BNKA0000000004",
    closed: true,
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnka-card": {
    bank: "bnka",
    holder: JOINT,
    import_id: "1001",
    closed: true,
    format: "card-export",
    reach: { import: "ongoing" },
  },
  "bnkb-personal": {
    bank: "bnkb",
    holder: SOLO,
    iban: "NL00BNKB0000000001",
    format: ACCOUNT,
    reach: { api: BNKB_API },
  },
  "bnkb-joint": {
    bank: "bnkb",
    holder: JOINT,
    iban: "NL00BNKB0000000002",
    format: ACCOUNT,
    reach: { api: BNKB_API },
  },
  "bnkb-personal-savings": {
    bank: "bnkb",
    holder: SOLO,
    iban: "NL00BNKB0000000003",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnkb-joint-savings": {
    bank: "bnkb",
    holder: JOINT,
    iban: "NL00BNKB0000000004",
    format: ACCOUNT,
    reach: { import: "ongoing" },
  },
  "bnkb-card": {
    bank: "bnkb",
    holder: JOINT,
    import_id: "2001",
    format: "card-export",
    reach: { import: "ongoing" },
  },
};

export const accountFor = (role: Role, day: number): AccountKey => {
  const atBnkb = day >= SWITCH;
  switch (role) {
    case "personal":
      return "bnka-personal";
    case "personal-savings":
      return "bnka-personal-savings";
    case "joint":
      return atBnkb ? "bnkb-joint" : "bnka-joint";
    case "joint-savings":
      return atBnkb ? "bnkb-joint-savings" : "bnka-joint-savings";
    case "card":
      return atBnkb ? "bnkb-card" : "bnka-card";
    case "second-personal":
      return "bnkb-personal";
    case "second-savings":
      return "bnkb-personal-savings";
  }
};

// Two made-up export formats. The first has a sequence number and a counterparty. The
// second, for cards, has neither a counterparty nor an IBAN.
export const FORMATS: Record<FormatKey, ImportFormat> = {
  "account-export": {
    delimiter: ";",
    encoding: "utf-8",
    account: { column: "Account" },
    id: { column: "Sequence" },
    date: { column: "Booked", format: "YYYY-MM-DD" },
    value_date: { column: "Value date", format: "YYYY-MM-DD" },
    amount: { column: "Amount", decimal: "," },
    currency: { column: "Currency" },
    counterparty_name: { column: "Counterparty" },
    counterparty_account: { column: "Counterparty account" },
    description: { columns: ["Text 1", "Text 2", "Text 3"] },
    code: { column: "Type" },
    original_amount: { column: "Original amount", decimal: "," },
    original_currency: { column: "Original currency" },
  },
  "card-export": {
    delimiter: ";",
    encoding: "utf-8",
    account: { column: "Card" },
    id: { column: "Reference" },
    date: { column: "Booked", format: "YYYY-MM-DD" },
    amount: { column: "Amount", decimal: "," },
    currency: { column: "Currency" },
    description: { columns: ["Text"] },
    original_amount: { column: "Original amount", decimal: "," },
    original_currency: { column: "Original currency" },
  },
};

export const CONFIG: Config = {
  banks: {
    bnka: { aspsp: { name: "Example Bank A", country: "NL" } },
    bnkb: { aspsp: { name: "Example Bank B", country: "NL" } },
  },
  accounts: Object.fromEntries(
    Object.entries(ACCOUNTS).map(([key, account]) => [
      key,
      {
        bank: account.bank,
        ...(account.iban === undefined ? {} : { iban: account.iban }),
        ...(account.import_id === undefined ? {} : { import_id: account.import_id }),
        ...(account.closed === undefined ? {} : { closed: true }),
      },
    ]),
  ),
  imports: FORMATS,
};

export const HISTORY_UNTIL = utcDay(2025, 3, 31);
const HISTORY_IMPORTED_AT = "2025-04-02T19:14:05Z";

// When the row for a transaction booked on `day` was imported, or null if it never was:
// either it falls after a one-off history export, or its quarter has not been exported yet.
export const importedAt = (account: AccountKey, day: number, lastNight: number): string | null => {
  const plan = ACCOUNTS[account].reach.import;
  if (plan === undefined) return null;
  if (day <= HISTORY_UNTIL) return HISTORY_IMPORTED_AT;
  if (plan === "history") return null;
  const { y, m } = parts(day);
  const nextQuarter = utcDay(y, Math.floor((m - 1) / 3) * 3 + 4, 1);
  return nextQuarter >= lastNight ? null : `${iso(nextQuarter)}T20:00:00Z`;
};
