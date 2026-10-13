// A table to one batch per account, ready for merge. A row's identifier and booking date
// are read here, once, and its amount and currency are checked. Nothing else of a row is
// judged: `raw` is stored as it is, and the view interprets it.
import { CURRENCY_CODE, namedColumns, parseAmount, parseDate } from "@money/shared";
import type { Config, ImportFormat, ImportRaw, Incoming } from "@money/shared";

import { plainIban } from "../iban.ts";
import type { Table } from "./delimited.ts";
import { reject } from "./error.ts";

export type Batch = { account: string; incoming: Incoming[] };

// What an export file calls an account, to its key: the import_id exactly, or the IBAN
// whatever its spacing and case. The configuration refuses two accounts that share either.
const accountFinder = (accounts: Config["accounts"]): ((cell: string) => string | undefined) => {
  const byImportId = new Map<string, string>();
  const byIban = new Map<string, string>();
  for (const [key, account] of Object.entries(accounts)) {
    if (account.import_id !== undefined) byImportId.set(account.import_id, key);
    if (account.iban !== undefined) byIban.set(plainIban(account.iban), key);
  }
  return (cell) => byImportId.get(cell) ?? byIban.get(plainIban(cell));
};

export const readRows = (
  table: Table,
  format: ImportFormat,
  accounts: Config["accounts"],
): Batch[] => {
  const { header, rows } = table;
  const missing = namedColumns(format)
    .filter(([, column]) => !header.includes(column))
    .map(([field]) => `the header lacks the column that the format names as ${field}`);
  if (missing.length > 0) throw reject(missing);

  const at = {
    account: header.indexOf(format.account.column),
    id: header.indexOf(format.id.column),
    date: header.indexOf(format.date.column),
    amount: header.indexOf(format.amount.column),
    currency: header.indexOf(format.currency.column),
  };
  const find = accountFinder(accounts);
  const problems: string[] = [];
  const batches = new Map<string, Incoming[]>();
  // Per account, the row each identifier was first seen on.
  const firstRow = new Map<string, Map<string, number>>();

  rows.forEach((cells, index) => {
    const row = `row ${index + 2}`;
    const before = problems.length;
    const account = find(cells[at.account]);
    if (account === undefined) problems.push(`${row} is for an account that is not configured`);
    const id = cells[at.id];
    if (id === "") problems.push(`${row} has no identifier`);
    const date = parseDate(cells[at.date], format.date.format);
    if (date === null) problems.push(`${row} has a date that cannot be read`);
    const currency = cells[at.currency];
    if (!CURRENCY_CODE.test(currency)) {
      problems.push(`${row} has a currency that cannot be read`);
    } else if (parseAmount(cells[at.amount], format.amount.decimal, currency) === null) {
      problems.push(`${row} has an amount that cannot be read`);
    }
    if (account !== undefined && id !== "") {
      const seen = firstRow.get(account) ?? new Map<string, number>();
      firstRow.set(account, seen);
      const earlier = seen.get(id);
      // Stricter than merge, which accepts an identical repeat: a file that lists one
      // transaction twice is not the export it claims to be.
      if (earlier !== undefined) problems.push(`${row} repeats the identifier of row ${earlier}`);
      else seen.set(id, index + 2);
    }
    if (problems.length > before || account === undefined || date === null) return;

    const raw: ImportRaw = Object.fromEntries(header.map((name, column) => [name, cells[column]]));
    const batch = batches.get(account) ?? [];
    batches.set(account, batch);
    batch.push({ id, date, raw });
  });

  if (problems.length > 0) throw reject(problems);
  return [...batches]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([account, incoming]) => ({ account, incoming }));
};
