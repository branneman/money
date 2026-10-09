import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { apiStarts, identityOf, validateConfig, view, visibleRecords } from "@money/shared";
import type { ArchiveRecord } from "@money/shared";
import { readArchive } from "@money/shared/node";

import { ARCHIVE_DIR, buildArchive, CONFIG_PATH, renderArchive, renderConfig } from "./generate.ts";
import { ACCOUNTS, CONFIG, FORMATS } from "./world.ts";
import type { AccountKey } from "./world.ts";

const records = buildArchive();
const files = renderArchive(records);
const shown = view(records, FORMATS);
const of = (account: AccountKey, source: "api" | "import"): ArchiveRecord[] =>
  records.filter((record) => record.account === account && record.source === source);

test("the committed archive is exactly what the generator produces", async () => {
  const onDisk = renderArchive(await readArchive(ARCHIVE_DIR));
  assert.deepEqual([...onDisk.keys()].toSorted(), [...files.keys()].toSorted());
  for (const [path, text] of files) {
    // Compared by equality, not deepEqual on the text: a mismatch would print megabytes.
    assert.ok(
      readFileSync(`${ARCHIVE_DIR}/${path}`, "utf8") === text,
      `${path} is stale: run npm run fixtures`,
    );
  }
  assert.ok(
    readFileSync(CONFIG_PATH, "utf8") === renderConfig(),
    "config.json is stale: run npm run fixtures",
  );
});

test("generating twice gives the same bytes", () => {
  assert.deepEqual([...renderArchive(buildArchive())], [...files]);
});

test("the configuration is valid", () => {
  const result = validateConfig(JSON.parse(renderConfig()));
  assert.deepEqual(result.ok ? [] : result.problems, []);
});

test("identity is unique across the whole archive", () => {
  const identities = records.map(identityOf);
  assert.equal(new Set(identities).size, identities.length);
});

test("every configured account has records, and only from the sources that reach it", () => {
  for (const [key, account] of Object.entries(ACCOUNTS) as [
    AccountKey,
    (typeof ACCOUNTS)[AccountKey],
  ][]) {
    assert.equal(of(key, "api").length > 0, account.reach.api !== undefined, `${key} api`);
    assert.equal(of(key, "import").length > 0, account.reach.import !== undefined, `${key} import`);
  }
  assert.deepEqual(
    [...new Set(records.map((record) => record.account))].toSorted(),
    Object.keys(CONFIG.accounts).toSorted(),
  );
});

test("accounts without an IBAN are recognised by their import id", () => {
  for (const key of ["bnka-card", "bnkb-card"] as const) {
    assert.equal(CONFIG.accounts[key].iban, undefined);
    assert.ok(
      of(key, "import").every((record) => record.raw.Card === CONFIG.accounts[key].import_id),
    );
  }
});

test("where both sources cover an account, they overlap and the view hides the import", () => {
  const starts = apiStarts(records);
  for (const key of ["bnka-personal", "bnka-joint"] as const) {
    const start = starts.get(key) ?? "";
    // The API reaches back to 1 January 2025; the first booking is on or just after it.
    assert.ok(start >= "2025-01-01" && start <= "2025-01-03", `${key} starts at ${start}`);
    const overlapping = of(key, "import").filter((record) => record.date >= start);
    assert.ok(
      overlapping.length > 50,
      `${key} has only ${overlapping.length} overlapping import records`,
    );
    assert.ok(of(key, "import").some((record) => record.date < start));
    const visible = new Set(visibleRecords(records).map(identityOf));
    assert.ok(overlapping.every((record) => !visible.has(identityOf(record))));
  }
  assert.ok(shown.length < records.length);
});

test("the closed account receives nothing after it closed", () => {
  assert.equal(CONFIG.accounts["bnka-joint"].closed, true);
  const last = of("bnka-joint", "api").at(-1)?.date ?? "";
  assert.equal(last, "2026-04-01");
});

test("a transfer between two of the household's accounts appears on both", () => {
  const moved = shown.filter(
    (item) =>
      item.description === "Saldo overboeken" &&
      ["bnka-joint", "bnkb-joint"].includes(item.account),
  );
  assert.deepEqual(moved.map((item) => item.account).toSorted(), ["bnka-joint", "bnkb-joint"]);
  assert.equal(moved[0].amount + moved[1].amount, 0);
});

test("every record normalises, and amounts are never zero", () => {
  assert.ok(shown.every((item) => Number.isSafeInteger(item.amount) && item.amount !== 0));
  assert.ok(shown.every((item) => item.currency === "EUR"));
});

test("no generated IBAN can be a real one", () => {
  const ibans = shown.flatMap((item) =>
    item.counterparty_account === null ? [] : [item.counterparty_account],
  );
  assert.ok(ibans.length > 1000);
  // Check digits 00 never pass the IBAN checksum.
  for (const iban of ibans) assert.match(iban, /^NL00[A-Z]{4}\d{10}$/);
  for (const account of Object.values(CONFIG.accounts)) {
    if (account.iban !== undefined) assert.match(account.iban, /^NL00BNK[AB]\d{10}$/);
  }
});

test("records were seen after they were booked, and revisions after that", () => {
  for (const record of records) {
    assert.ok(record.first_seen.slice(0, 10) > record.date, identityOf(record));
    for (const revision of record.revisions) assert.ok(revision.replaced_at > record.first_seen);
  }
});

test("the archive contains the cases the app has to handle", () => {
  const count = (predicate: (item: (typeof shown)[number]) => boolean): number =>
    shown.filter(predicate).length;
  assert.ok(records.length > 5000, `only ${records.length} records`);
  assert.ok(count((item) => item.revised) > 5, "revised transactions");
  assert.ok(count((item) => item.original_currency !== null) > 20, "foreign-currency transactions");
  assert.ok(
    count((item) => item.counterparty_name === null) > 100,
    "transactions without a counterparty",
  );
  assert.ok(count((item) => item.amount > 0) > 300, "credits");
  assert.ok(count((item) => item.source === "import") > 2000, "imported transactions in view");

  const lookalikes = Map.groupBy(shown, (item) =>
    [item.account, item.date, item.counterparty_name, item.amount, item.description].join("\u0000"),
  );
  assert.ok(
    [...lookalikes.values()].some((group) => group.length > 1),
    "identical-looking transactions on one day",
  );

  const firstSeen = Map.groupBy(of("bnka-personal", "api"), (record) =>
    record.first_seen.slice(0, 10),
  );
  assert.ok(!firstSeen.has("2025-07-08"), "a night without a sync");
});
