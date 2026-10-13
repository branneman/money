import assert from "node:assert/strict";
import { test } from "node:test";

import { normalise } from "@money/shared";
import type { Config, ImportRaw } from "@money/shared";
import { aFormat, anImportRaw, anImportRecord } from "@money/shared/testing";

import type { Table } from "./delimited.ts";
import { ImportError } from "./error.ts";
import { readRows } from "./rows.ts";

const ACCOUNTS: Config["accounts"] = {
  "bnka-current": { bank: "bnka", iban: "NL00BNKA0000000001" },
  "bnka-joint": { bank: "bnka", iban: "nl00 bnka 0000 0000 02" },
  "bnka-card": { bank: "bnka", import_id: "1001" },
};

const HEADER = Object.keys(anImportRaw());
const row = (overrides: Record<string, string> = {}): string[] =>
  Object.values(anImportRaw(overrides));
const table = (...rows: string[][]): Table => ({ header: HEADER, rows });

const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ImportError);
    return error.message;
  }
  return assert.fail("the file was accepted");
};

test("a row becomes an incoming transaction whose raw is the row, untouched", () => {
  const raw = anImportRaw({ Counterparty: "  Example Shop ", "Text 3": "" });
  const batches = readRows(table(Object.values(raw)), aFormat(), ACCOUNTS);
  assert.deepEqual(batches, [
    {
      account: "bnka-current",
      incoming: [{ id: "000000000000000001", date: "2025-01-02", raw }],
    },
  ]);
  assert.deepEqual(Object.keys(batches[0].incoming[0].raw), HEADER);
});

test("the date is read by the format's notation", () => {
  const format = aFormat({ date: { column: "Booked", format: "DD-MM-YYYY" } });
  const batches = readRows(table(row({ Booked: "31-12-2024" })), format, ACCOUNTS);
  assert.equal(batches[0].incoming[0].date, "2024-12-31");
});

test("an account is found by its IBAN whatever the spacing and case, on either side", () => {
  const batches = readRows(
    table(
      row({ Account: "nl00 bnka 0000 0000 01", Sequence: "1" }),
      row({ Account: "NL00BNKA0000000002", Sequence: "2" }),
    ),
    aFormat(),
    ACCOUNTS,
  );
  assert.deepEqual(
    batches.map((batch) => batch.account),
    ["bnka-current", "bnka-joint"],
  );
});

test("an account without an IBAN is found by its import_id, exactly", () => {
  const batches = readRows(table(row({ Account: "1001" })), aFormat(), ACCOUNTS);
  assert.equal(batches[0].account, "bnka-card");
  assert.match(
    refusal(() => readRows(table(row({ Account: " 1001" })), aFormat(), ACCOUNTS)),
    /^row 2 is for an account that is not configured$/,
  );
});

test("one file may hold several accounts, and they may share an identifier", () => {
  const batches = readRows(
    table(
      row({ Account: "1001", Sequence: "7" }),
      row({ Sequence: "7" }),
      row({ Account: "1001", Sequence: "8" }),
    ),
    aFormat(),
    ACCOUNTS,
  );
  assert.deepEqual(
    batches.map((batch) => [batch.account, batch.incoming.map((item) => item.id)]),
    [
      ["bnka-card", ["7", "8"]],
      ["bnka-current", ["7"]],
    ],
  );
});

test("a column named like an object's own machinery is an ordinary column", () => {
  const header = [...HEADER, "__proto__", "constructor"];
  const batches = readRows({ header, rows: [[...row(), "one", "two"]] }, aFormat(), ACCOUNTS);
  const { raw } = batches[0].incoming[0];
  assert.deepEqual(Object.keys(raw), header);
  assert.equal(Object.getOwnPropertyDescriptor(raw, "__proto__")?.value, "one");
  assert.equal(raw.constructor, "two");
  assert.deepEqual(JSON.parse(JSON.stringify(raw)), raw);
});

const refused: [string, string[][], RegExp][] = [
  [
    "an unknown account",
    [row({ Account: "NL00BNKA0000000009" })],
    /^row 2 is for an account that is not configured$/,
  ],
  ["an empty identifier", [row({ Sequence: "" })], /^row 2 has no identifier$/],
  [
    "a date that is not a date",
    [row({ Booked: "2025-02-30" })],
    /^row 2 has a date that cannot be read$/,
  ],
  [
    "a date in another notation",
    [row({ Booked: "02-01-2025" })],
    /^row 2 has a date that cannot be read$/,
  ],
  [
    "an amount with a thousands separator",
    [row({ Amount: "-1.234,56" })],
    /^row 2 has an amount that cannot be read$/,
  ],
  ["an empty amount", [row({ Amount: "" })], /^row 2 has an amount that cannot be read$/],
  [
    "a currency that is not three capitals",
    [row({ Currency: "eur" })],
    /^row 2 has a currency that cannot be read$/,
  ],
  ["an empty currency", [row({ Currency: "" })], /^row 2 has no currency$/],
  [
    "a value date of one space, which the view could not read",
    [row({ "Value date": " " })],
    /^row 2 has a value date that cannot be read$/,
  ],
  [
    "an original amount of one space beside an empty currency",
    [row({ "Original amount": " " })],
    /^row 2 has an original amount without a currency$/,
  ],
  [
    "an original currency without an amount",
    [row({ "Original currency": "USD" })],
    /^row 2 has an original currency without an amount$/,
  ],
  [
    "an original amount that cannot be read",
    [row({ "Original amount": "1.000,00", "Original currency": "USD" })],
    /^row 2 has an original amount that cannot be read$/,
  ],
  [
    "an identifier used twice in one account, identical rows",
    [row(), row()],
    /^row 3 repeats the identifier of row 2$/,
  ],
  [
    "an identifier used twice in one account, different rows",
    [row(), row({ Sequence: "2" }), row({ Amount: "-1,00" })],
    /^row 4 repeats the identifier of row 2$/,
  ],
];

for (const [label, rows, pattern] of refused) {
  test(`refused: ${label}`, () => {
    assert.match(
      refusal(() => readRows(table(...rows), aFormat(), ACCOUNTS)),
      pattern,
    );
  });
}

test("every row that is accepted is one the view can read", () => {
  const rows = [
    row({ Sequence: "1", "Value date": "", "Original amount": "", "Original currency": "" }),
    row({ Sequence: "2", "Original amount": "10,00", "Original currency": "USD" }),
    row({ Sequence: "3", Counterparty: " ", "Text 1": " ", Type: " " }),
  ];
  const [batch] = readRows(table(...rows), aFormat(), ACCOUNTS);
  for (const item of batch.incoming) {
    const record = anImportRecord({ id: item.id, date: item.date, raw: item.raw as ImportRaw });
    assert.doesNotThrow(() => normalise(record, { "example-export": aFormat() }));
  }
});

test("every problem is reported, by row, and good rows do not save the file", () => {
  const message = refusal(() =>
    readRows(
      table(row(), row({ Sequence: "2", Amount: "x" }), row({ Sequence: "", Booked: "x" })),
      aFormat(),
      ACCOUNTS,
    ),
  );
  assert.deepEqual(message.split("\n"), [
    "row 3 has an amount that cannot be read",
    "row 4 has no identifier",
    "row 4 has a date that cannot be read",
  ]);
});

test("a column the format names and the header lacks is named by its field", () => {
  const header = HEADER.filter((name) => name !== "Amount" && name !== "Text 2");
  const message = refusal(() =>
    readRows({ header, rows: [header.map(() => "x")] }, aFormat(), ACCOUNTS),
  );
  assert.deepEqual(message.split("\n"), [
    "the header lacks the column that the format names as amount",
    "the header lacks the column that the format names as description, column 2",
  ]);
});

test("a refusal never repeats a cell or a header name", () => {
  const message = refusal(() =>
    readRows(
      table(
        row({ Account: "Zqxaccount" }),
        row({ Sequence: "Zqxid", Amount: "Zqxamount", Booked: "Zqxdate" }),
        row({ Sequence: "Zqxid", Currency: "Zqxcurrency" }),
      ),
      aFormat(),
      ACCOUNTS,
    ),
  );
  assert.ok(!message.includes("Zqx"));
  assert.ok(!HEADER.some((name) => message.includes(name)));
});

test("fifty thousand rows become one batch without trouble", () => {
  const rows = Array.from({ length: 50_000 }, (_, index) => row({ Sequence: String(index) }));
  const batches = readRows(table(...rows), aFormat(), ACCOUNTS);
  assert.equal(batches[0].incoming.length, 50_000);
});
