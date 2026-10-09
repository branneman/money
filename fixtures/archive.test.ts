import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { ACCOUNTS, ARCHIVE_DIR, buildArchive, renderYearFiles } from "./generate.ts";
import type { ArchiveRecord } from "./generate.ts";

const records = buildArchive();
const files = renderYearFiles(records);

test("the committed archive is exactly what the generator produces", () => {
  const committed = readdirSync(ARCHIVE_DIR)
    .filter((name) => name.endsWith(".json"))
    .toSorted();
  assert.deepEqual(committed, [...files.keys()].toSorted());
  for (const [name, contents] of files) {
    // Compared by equality, not deepEqual on the text: a mismatch would print megabytes.
    assert.ok(
      readFileSync(join(ARCHIVE_DIR, name), "utf8") === contents,
      `${name} is stale: run npm run fixtures`,
    );
  }
});

test("generating twice gives the same bytes", () => {
  assert.deepEqual([...renderYearFiles(buildArchive())], [...files]);
});

test("identity is unique: no two records share an account and entry reference", () => {
  const identities = records.map((item) => `${item.account} ${item.entry_reference}`);
  assert.equal(new Set(identities).size, identities.length);
});

test("every file holds only its own booking year, sorted by date, account and reference", () => {
  for (const [name, contents] of files) {
    const items = JSON.parse(contents) as ArchiveRecord[];
    const keys = items.map(
      (item) => `${item.raw.booking_date} ${item.account} ${item.entry_reference}`,
    );
    assert.deepEqual(keys, keys.toSorted(), `${name} is not sorted`);
    assert.ok(
      items.every((item) => `${item.raw.booking_date.slice(0, 4)}.json` === name),
      `${name} holds another year`,
    );
  }
});

test("records are well-formed", () => {
  const ownIbans = Object.values(ACCOUNTS).map((account) => account.iban);
  for (const item of records) {
    const { raw } = item;
    assert.ok(ownIbans.includes(item.account));
    assert.equal(item.entry_reference, raw.entry_reference);
    assert.match(raw.transaction_amount.amount, /^\d+\.\d{2}$/);
    assert.notEqual(raw.transaction_amount.amount, "0.00");
    assert.match(raw.booking_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(raw.transaction_date <= raw.booking_date);
    assert.ok(item.first_seen.slice(0, 10) > raw.booking_date, "seen before it was booked");
    const own = raw.credit_debit_indicator === "CRDT" ? raw.creditor_account : raw.debtor_account;
    assert.equal(own?.iban, item.account);
    for (const revision of item.revisions) {
      assert.ok(revision.replaced_at > item.first_seen);
      assert.notDeepEqual(revision.raw, raw);
    }
  }
});

test("no generated IBAN can be a real one", () => {
  const ibans = records.flatMap((item) => [
    item.raw.creditor_account?.iban,
    item.raw.debtor_account?.iban,
  ]);
  for (const iban of ibans) {
    // Check digits 00 never pass the IBAN checksum.
    if (iban !== undefined) assert.match(iban, /^NL00[A-Z]{4}\d{10}$/);
  }
});

test("the archive contains the cases the app has to handle", () => {
  const count = (predicate: (item: ArchiveRecord) => boolean): number =>
    records.filter(predicate).length;
  assert.ok(records.length > 5000, `only ${records.length} records`);
  assert.ok(count((item) => item.revisions.length > 0) > 5, "revised transactions");
  assert.ok(count((item) => item.raw.exchange_rate !== null) > 20, "foreign-currency transactions");
  assert.ok(
    count((item) => item.raw.creditor === null) > 10,
    "transactions without a counterparty",
  );
  assert.ok(
    count((item) => item.raw.transaction_date < item.raw.booking_date) > 100,
    "booked a day late",
  );
  assert.ok(count((item) => item.raw.credit_debit_indicator === "CRDT") > 200, "credits");

  const lookalikes = Map.groupBy(records, (item) =>
    [
      item.account,
      item.raw.booking_date,
      item.raw.creditor?.name,
      item.raw.transaction_amount.amount,
      item.raw.remittance_information.join("|"),
    ].join(" "),
  );
  assert.ok(
    [...lookalikes.values()].some((group) => group.length > 1),
    "identical-looking transactions on one day",
  );
});
