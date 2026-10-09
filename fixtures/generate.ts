// Generates fixtures/archive/ and fixtures/config.json: a synthetic archive in the layout
// docs/archive-format.md describes. Everything in it is invented.
//
//   npm run fixtures
//
// It is deterministic: fixed seeds, a fixed date range, no clock. Every record goes through
// the real merge and the real file rendering, so the fixtures cannot drift from the format.
// fixtures/archive.test.ts fails if the committed files differ from what this produces.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { merge, renderYearFiles } from "@money/shared";
import type { ApiRaw, ArchiveRecord, ImportRaw, Incoming, Target } from "@money/shared";

import { iso, pad, utcDay } from "./dates.ts";
import { END, hash, KINDS, makeRng, simulate } from "./household.ts";
import type { Posting } from "./household.ts";
import { ACCOUNTS, CONFIG, importedAt } from "./world.ts";
import type { AccountKey } from "./world.ts";

export const ARCHIVE_DIR = join(import.meta.dirname, "archive");
export const CONFIG_PATH = join(import.meta.dirname, "config.json");

// The sync that ran the night after the last simulated day.
const LAST_NIGHT = END + 1;

// Nights without a successful sync. Transactions booked in these windows were first seen
// on the night the sync came back.
const OUTAGES: readonly (readonly [number, number])[] = [
  [utcDay(2025, 7, 6), utcDay(2025, 7, 13)],
  [utcDay(2026, 2, 10), utcDay(2026, 2, 12)],
];
const inOutage = (day: number): boolean => OUTAGES.some(([from, to]) => day >= from && day <= to);
const nextSyncNight = (day: number): number => (inOutage(day) ? nextSyncNight(day + 1) : day);
// The sync runs at 03:00 UTC and takes a few seconds, never the same number twice running.
const syncInstant = (day: number): string =>
  `${iso(day)}T03:00:${pad(3 + (hash(`sync:${day}`) % 50))}Z`;

const euros = (cents: number): string => (cents / 100).toFixed(2);
const signedComma = (cents: number): string =>
  `${cents < 0 ? "-" : "+"}${euros(Math.abs(cents)).replace(".", ",")}`;

// The shape is the Transaction schema from Enable Banking's API reference, not an observed
// bank response. Fields the generator has no basis to invent are null, so nothing built on
// this data can come to depend on them.
const apiRaw = ({ day, account, event }: Posting, entryReference: string): ApiRaw => {
  const own = ACCOUNTS[account];
  const isCredit = event.cents > 0;
  const self = { name: own.holder };
  const selfAccount = own.iban === undefined ? null : { iban: own.iban };
  const other = event.party === null ? null : { name: event.party };
  const otherAccount = event.iban === null ? null : { iban: event.iban };
  return {
    entry_reference: entryReference,
    transaction_amount: { currency: "EUR", amount: euros(Math.abs(event.cents)) },
    credit_debit_indicator: isCredit ? "CRDT" : "DBIT",
    status: "BOOK",
    booking_date: iso(day),
    value_date: iso(day),
    transaction_date: iso(day - (event.daysBeforeBooking ?? 0)),
    creditor: isCredit ? self : other,
    creditor_account: isCredit ? selfAccount : otherAccount,
    creditor_agent: null,
    debtor: isCredit ? other : self,
    debtor_account: isCredit ? otherAccount : selfAccount,
    debtor_agent: null,
    bank_transaction_code: { ...KINDS[event.kind], sub_code: null },
    merchant_category_code: null,
    remittance_information: event.remittance,
    exchange_rate: event.exchange ?? null,
    balance_after_transaction: null,
    reference_number: null,
    reference_number_schema: null,
    debtor_account_additional_identification: null,
    creditor_account_additional_identification: null,
    note: null,
    transaction_id: null,
  };
};

// One row of a made-up export file. Every cell is text, in the file's own notation.
const importRow = ({ day, account, event }: Posting, id: string): ImportRaw => {
  const own = ACCOUNTS[account];
  const original = event.exchange?.instructed_amount;
  const foreign = {
    "Original amount": original === undefined ? "" : original.amount.replace(".", ","),
    "Original currency": original?.currency ?? "",
  };
  if (own.format === "card-export") {
    return {
      Card: own.import_id ?? "",
      Currency: "EUR",
      Reference: id,
      Booked: iso(day),
      Amount: signedComma(event.cents),
      Text: event.remittance[0] ?? event.party ?? "",
      ...foreign,
    };
  }
  return {
    Account: own.iban ?? "",
    Currency: "EUR",
    Sequence: id,
    Booked: iso(day),
    "Value date": iso(day),
    Amount: signedComma(event.cents),
    "Counterparty account": event.iban ?? "",
    Counterparty: event.party ?? "",
    Type: KINDS[event.kind].code.toLowerCase(),
    "Text 1": event.remittance[0] ?? "",
    "Text 2": event.remittance[1] ?? "",
    "Text 3": event.remittance[2] ?? "",
    ...foreign,
  };
};

// One batch-to-be: a transaction, where it is going, and when it got there.
export type Arrival = { target: Target; at: string; incoming: Incoming };

export const buildArrivals = (): Arrival[] => {
  const r = makeRng(20250401);
  const references = new Map<string, number>();
  const sequences = new Map<AccountKey, number>();
  const arrivals: Arrival[] = [];

  for (const posting of simulate()) {
    const { day, account, event } = posting;
    const { reach, format } = ACCOUNTS[account];
    const date = iso(day);

    if (reach.api !== undefined && day >= reach.api.from) {
      const key = `${account}:${day}`;
      const sequence =
        (references.get(key) ?? 10_000_000 + (hash(key) % 80_000_000)) + r.int(1, 997);
      references.set(key, sequence);
      const id = `${date.replaceAll("-", "")}-${sequence}`;
      const raw = apiRaw(posting, id);
      const target: Target = { account, source: "api" };

      const booked = day + (r.chance(0.15) ? 2 : 1);
      const firstNight = Math.min(LAST_NIGHT, nextSyncNight(Math.max(reach.api.firstSync, booked)));
      // Now and then the bank changes a transaction after it was first stored. Here the
      // earlier version lacked its last remittance line.
      const revisedNight = nextSyncNight(firstNight + r.int(1, 3));
      const revised = r.chance(0.01) && event.remittance.length > 1 && revisedNight <= LAST_NIGHT;

      const first = revised
        ? { ...raw, remittance_information: event.remittance.slice(0, -1) }
        : raw;
      arrivals.push({ target, at: syncInstant(firstNight), incoming: { id, date, raw: first } });
      if (revised)
        arrivals.push({ target, at: syncInstant(revisedNight), incoming: { id, date, raw } });
    }

    if (reach.import !== undefined) {
      // Numbered whether or not the row was ever exported, as a bank numbers them.
      const sequence = (sequences.get(account) ?? 0) + 1;
      sequences.set(account, sequence);
      const at = importedAt(account, day, LAST_NIGHT);
      if (at !== null) {
        const id =
          format === "card-export"
            ? `P${pad(100_000_000 + sequence * 7_919, 12)}`
            : pad(sequence, 18);
        const target: Target = { account, source: "import", format };
        arrivals.push({ target, at, incoming: { id, date, raw: importRow(posting, id) } });
      }
    }
  }
  return arrivals;
};

// Feeds every arrival through the real merge, per account and source, in the order the
// batches arrived.
export const buildArchive = (arrivals: readonly Arrival[] = buildArrivals()): ArchiveRecord[] =>
  [
    ...Map.groupBy(
      arrivals,
      (arrival) => `${arrival.target.account}/${arrival.target.source}`,
    ).values(),
  ].flatMap((feed) => {
    const inOrder = feed.toSorted((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
    let stored: ArchiveRecord[] = [];
    for (const [at, batch] of Map.groupBy(inOrder, (arrival) => arrival.at)) {
      stored = merge(
        stored,
        batch.map((arrival) => arrival.incoming),
        batch[0].target,
        at,
      ).records;
    }
    return stored;
  });

// Path below the archive directory to exact file text.
export const renderArchive = (records: readonly ArchiveRecord[]): Map<string, string> => {
  const files = new Map<string, string>();
  for (const [dir, group] of Map.groupBy(
    records,
    (record) => `${record.account}/${record.source}`,
  )) {
    for (const [name, text] of renderYearFiles(group)) files.set(`${dir}/${name}`, text);
  }
  return files;
};

export const renderConfig = (): string => `${JSON.stringify(CONFIG, null, 2)}\n`;

if (import.meta.main) {
  const files = renderArchive(buildArchive());
  rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  for (const [path, text] of files) {
    mkdirSync(dirname(join(ARCHIVE_DIR, path)), { recursive: true });
    writeFileSync(join(ARCHIVE_DIR, path), text);
  }
  writeFileSync(CONFIG_PATH, renderConfig());
  console.log(`wrote ${files.size} year files and config.json`);
}
