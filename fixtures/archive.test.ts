import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { apiStarts, identityOf, validateConfig, view, visibleRecords } from "@money/shared";
import type { ArchiveRecord } from "@money/shared";
import { readArchive } from "@money/shared/node";

import { iso, utcDay } from "./dates.ts";
import {
  ARCHIVE_DIR,
  buildArchive,
  CONFIG_PATH,
  OUTAGES,
  renderArchive,
  renderConfig,
} from "./generate.ts";
import { END } from "./household.ts";
import { ACCOUNTS, CONFIG, FORMATS, importedAt, SWITCH } from "./world.ts";
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

const dayOf = (date: string): number => {
  const [y, m, d] = date.split("-").map(Number);
  return utcDay(y, m, d);
};
const accountByIban = new Map(
  Object.entries(ACCOUNTS).flatMap(([key, account]) =>
    account.iban === undefined ? [] : [[account.iban, key as AccountKey] as const],
  ),
);

test("every transfer between the household's own accounts appears on both", () => {
  let pairs = 0;
  let switchMove = false;
  for (const item of shown) {
    const other =
      item.counterparty_account === null ? undefined : accountByIban.get(item.counterparty_account);
    if (other === undefined) continue;
    // An import-only account has nothing for a quarter that has not been exported yet.
    if (
      ACCOUNTS[other].reach.api === undefined &&
      importedAt(other, dayOf(item.date), END + 1) === null
    ) {
      continue;
    }
    const match = shown.find(
      (candidate) =>
        candidate.account === other &&
        candidate.date === item.date &&
        candidate.amount === -item.amount &&
        candidate.description === item.description,
    );
    assert.ok(match, `${item.account}/${item.id} has no counterpart on ${other}`);
    pairs++;
    if (
      item.account === "bnka-joint" &&
      other === "bnkb-joint" &&
      item.description === "Saldo overboeken"
    ) {
      switchMove = true;
    }
  }
  assert.ok(pairs > 300, `only ${pairs} paired transfers`);
  assert.ok(switchMove, "the switch-day move from bnka-joint to bnkb-joint");
});

test("every account that changes at the switch does so on the switch day", () => {
  const switchDate = iso(SWITCH);
  for (const key of ["bnka-joint", "bnka-joint-savings", "bnka-card"] as const) {
    assert.equal(CONFIG.accounts[key].closed, true, `${key} is closed`);
    const mine = records.filter((record) => record.account === key);
    assert.ok(mine.length > 0);
    assert.ok(
      mine.every((record) => record.date <= switchDate),
      `${key} has records after the switch`,
    );
  }
  for (const key of Object.keys(ACCOUNTS).filter((name) => name.startsWith("bnkb-"))) {
    const mine = records.filter((record) => record.account === key);
    assert.ok(mine.length > 0);
    assert.ok(
      mine.every((record) => record.date >= switchDate),
      `${key} has records before the switch`,
    );
  }
});

test("nothing is first seen during an outage, and the next night catches up", () => {
  const api = of("bnka-personal", "api");
  for (const [from, to] of OUTAGES) {
    const inside = api.filter((record) => {
      const seen = record.first_seen.slice(0, 10);
      return seen >= iso(from) && seen <= iso(to);
    });
    assert.equal(inside.length, 0, `first seen during the outage from ${iso(from)}`);
    const caughtUp = api.filter(
      (record) =>
        record.date >= iso(from) &&
        record.date <= iso(to) &&
        record.first_seen.startsWith(iso(to + 1)),
    );
    assert.ok(caughtUp.length > 0, `nothing caught up on ${iso(to + 1)}`);
  }
});

test("API records are internally consistent", () => {
  const api = records.filter((record) => record.source === "api");
  let lateBooked = 0;
  for (const record of api) {
    const raw = record.raw;
    assert.ok(String(raw.transaction_date) <= String(raw.booking_date), identityOf(record));
    if (String(raw.transaction_date) < String(raw.booking_date)) lateBooked++;
    const iban = ACCOUNTS[record.account as AccountKey].iban;
    const side = raw.credit_debit_indicator === "CRDT" ? raw.creditor_account : raw.debtor_account;
    assert.deepEqual(side, { iban }, identityOf(record));
    for (const revision of record.revisions) {
      assert.notDeepEqual(revision.raw, record.raw, identityOf(record));
    }
  }
  assert.ok(lateBooked > 100, `only ${lateBooked} booked after their transaction date`);
});

test("interest is only paid on an account that already has transactions", () => {
  let interest = 0;
  for (const key of Object.keys(ACCOUNTS) as AccountKey[]) {
    const mine = shown.filter((item) => item.account === key);
    const first = mine.find((item) => item.description.startsWith("Rente") === false);
    for (const item of mine.filter((candidate) => candidate.description.startsWith("Rente"))) {
      interest++;
      assert.ok(first !== undefined && first.date <= item.date, `${key} interest before activity`);
      assert.ok(item.amount > 0);
    }
  }
  assert.ok(interest > 0);
});

test("no bank is named in the fixtures", () => {
  const forbidden = [
    ["AA", "B INZ"],
    ["Flor", "ius"],
  ].map((fragments) => fragments.join(""));
  const texts = [
    ...readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => readFileSync(`${import.meta.dirname}/${name}`, "utf8")),
    ...files.values(),
  ];
  for (const text of texts) {
    for (const word of forbidden) {
      assert.ok(!text.toLowerCase().includes(word.toLowerCase()), "a forbidden name appears");
    }
  }
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
