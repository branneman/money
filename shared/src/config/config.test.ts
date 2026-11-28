import assert from "node:assert/strict";
import { test } from "node:test";

import { aConfig, aFormat } from "../../testing/factories.ts";
import { namedColumns, validateConfig } from "./config.ts";

const problemsOf = (value: unknown): string[] => {
  const result = validateConfig(value);
  return result.ok ? [] : result.problems;
};

test("a valid configuration passes and comes back typed", () => {
  const result = validateConfig(structuredClone(aConfig()));
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.config, aConfig());
});

test("an amount column may declare a thousands separator", () => {
  const config = aConfig({
    imports: {
      x: aFormat({
        amount: { column: "Amount", decimal: ",", thousands: "." },
        original_amount: { column: "Original amount", decimal: ".", thousands: "," },
      }),
    },
  });
  const result = validateConfig(structuredClone(config));
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.config, config);
});

test("an open account with an iban may be left unfetched, and import still knows it", () => {
  const config = aConfig({
    accounts: { "bnka-savings": { bank: "bnka", iban: "NL00BNKA0000000009", fetch: false } },
  });
  const result = validateConfig(structuredClone(config));
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.config, config);
});

test("a configuration with only the three sections, all empty, is valid", () => {
  assert.ok(validateConfig({ banks: {}, accounts: {}, imports: {} }).ok);
});

const wrong: [string, unknown, RegExp][] = [
  ["something that is not an object", [], /not a JSON object/],
  ["no banks section", { accounts: {}, imports: {} }, /banks is missing/],
  [
    "a bank without a name",
    aConfig({ banks: { bnka: { aspsp: { name: "", country: "NL" } } } }),
    /banks\.bnka: aspsp\.name/,
  ],
  [
    "a bank with a bad country",
    aConfig({ banks: { bnka: { aspsp: { name: "Example Bank", country: "nl" } } } }),
    /banks\.bnka: aspsp\.country/,
  ],
  [
    "an account key with capitals",
    aConfig({ accounts: { "Bnka Current": { bank: "bnka", iban: "NL00BNKA0000000001" } } }),
    /accounts, entry 1: the key/,
  ],
  [
    "an account at an unknown bank",
    aConfig({ accounts: { a: { bank: "nope", iban: "NL00BNKA0000000001" } } }),
    /accounts\.a: its bank is not configured/,
  ],
  [
    "an account with neither identifier",
    aConfig({ accounts: { a: { bank: "bnka" } } }),
    /accounts\.a: needs an iban or an import_id/,
  ],
  [
    "a closed flag that is not a boolean",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001", closed: "yes" as unknown as boolean },
      },
    }),
    /accounts\.a: closed/,
  ],
  [
    "a fetch flag that is not a boolean",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001", fetch: "no" as unknown as boolean },
      },
    }),
    /accounts\.a: fetch must be true or false/,
  ],
  [
    "a numeric import_id beside a valid iban",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001", import_id: 1001 as unknown as string },
      },
    }),
    /accounts\.a: import_id must be a non-empty text/,
  ],
  [
    "an empty iban beside a valid import_id",
    aConfig({ accounts: { a: { bank: "bnka", iban: "", import_id: "1001" } } }),
    /accounts\.a: iban must be a non-empty text/,
  ],
  [
    "a bank key with capitals",
    aConfig({ banks: { "Bnk A": { aspsp: { name: "Example Bank", country: "NL" } } } }),
    /banks, entry 1: the key/,
  ],
  [
    "an import format key with capitals",
    aConfig({ imports: { "Bad Key": aFormat() } }),
    /imports, entry 1: the key/,
  ],
  [
    "two accounts with one IBAN",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001" },
        b: { bank: "bnka", iban: "NL00BNKA0000000001" },
      },
    }),
    /accounts\.b: shares its iban with a/,
  ],
  [
    "two accounts with one IBAN, written with other spacing and case",
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001" },
        b: { bank: "bnka", iban: "nl00 bnka 0000 0000 01" },
      },
    }),
    /accounts\.b: shares its iban with accounts\.a/,
  ],
  [
    "two accounts with one import_id",
    aConfig({
      accounts: { a: { bank: "bnka", import_id: "1" }, b: { bank: "bnka", import_id: "1" } },
    }),
    /accounts\.b: shares its import_id with a/,
  ],
  [
    "a format with a long delimiter",
    aConfig({ imports: { x: aFormat({ delimiter: ";;" }) } }),
    /imports\.x: delimiter/,
  ],
  [
    "a format with an unlisted encoding",
    aConfig({ imports: { x: aFormat({ encoding: "latin1" as "utf-8" }) } }),
    /imports\.x: encoding must be one of utf-8, windows-1252, iso-8859-15/,
  ],
  [
    "a format without an id column",
    aConfig({ imports: { x: { ...aFormat(), id: undefined } as never } }),
    /imports\.x: id/,
  ],
  [
    "a format with an unsupported date notation",
    aConfig({
      imports: { x: aFormat({ date: { column: "Booked", format: "MM/DD/YY" as "YYYYMMDD" } }) },
    }),
    /imports\.x: date\.format/,
  ],
  [
    "a format with a bad decimal mark",
    aConfig({ imports: { x: aFormat({ amount: { column: "Amount", decimal: " " as "," } }) } }),
    /imports\.x: amount\.decimal/,
  ],
  [
    "a format with an empty description list",
    aConfig({ imports: { x: aFormat({ description: { columns: [] } }) } }),
    /imports\.x: description/,
  ],
  [
    "a bad optional column",
    aConfig({ imports: { x: aFormat({ code: { column: "" } }) } }),
    /imports\.x: code/,
  ],
  [
    "a section the configuration does not know",
    { ...aConfig(), rules: {} },
    /^rules is not a section the configuration knows$/,
  ],
  [
    "a bank with a field it does not have",
    aConfig({
      banks: { bnka: { aspsp: { name: "Example Bank", country: "NL" }, nickname: "a" } as never },
    }),
    /banks\.bnka: nickname is not a field the configuration knows/,
  ],
  [
    "an aspsp with a field it does not have",
    aConfig({
      banks: { bnka: { aspsp: { name: "Example Bank", country: "NL", bic: "x" } as never } },
    }),
    /banks\.bnka: aspsp: bic is not a field the configuration knows/,
  ],
  [
    "an account with a mistyped field",
    aConfig({
      accounts: { a: { bank: "bnka", iban: "NL00BNKA0000000001", close: true } as never },
    }),
    /accounts\.a: close is not a field the configuration knows/,
  ],
  [
    "an import format with a mistyped field",
    aConfig({
      imports: { "example-export": { ...aFormat(), value_dat: { column: "Value date" } } as never },
    }),
    /imports\.example-export: value_dat is not a field the configuration knows/,
  ],
  [
    "an amount column with a field it does not have",
    aConfig({
      imports: {
        "example-export": aFormat({
          amount: { column: "Amount", decimal: ",", scale: 2 } as never,
        }),
      },
    }),
    /imports\.example-export: amount: scale is not a field the configuration knows/,
  ],
  [
    "a thousands separator that is not a point or a comma",
    aConfig({
      imports: {
        x: aFormat({ amount: { column: "Amount", decimal: ",", thousands: " " as "." } }),
      },
    }),
    /imports\.x: amount\.thousands must be a point or a comma/,
  ],
  [
    "a thousands separator that is also the decimal mark",
    aConfig({
      imports: {
        x: aFormat({
          original_amount: { column: "Original amount", decimal: ",", thousands: "," },
        }),
      },
    }),
    /imports\.x: original_amount\.thousands must differ from original_amount\.decimal/,
  ],
  [
    "a description with a field it does not have",
    aConfig({
      imports: {
        "example-export": aFormat({ description: { columns: ["Text 1"], join: " " } as never }),
      },
    }),
    /imports\.example-export: description: join is not a field the configuration knows/,
  ],
  [
    "an id column that is also the amount",
    aConfig({ imports: { "example-export": aFormat({ id: { column: "Amount" } }) } }),
    /imports\.example-export: id names the same column as amount/,
  ],
  [
    "an id column that is also a description column",
    aConfig({ imports: { "example-export": aFormat({ id: { column: "Text 2" } }) } }),
    /imports\.example-export: id names the same column as description, column 2/,
  ],
  [
    "a double quote as the delimiter",
    aConfig({ imports: { "example-export": aFormat({ delimiter: '"' }) } }),
    /imports\.example-export: delimiter may not be a double quote or a line ending/,
  ],
  [
    "a line ending as the delimiter",
    aConfig({ imports: { "example-export": aFormat({ delimiter: "\n" }) } }),
    /imports\.example-export: delimiter may not be a double quote or a line ending/,
  ],
];

for (const [name, value, message] of wrong) {
  test(`${name} is reported`, () => {
    const problems = problemsOf(value);
    assert.ok(
      problems.some((problem) => message.test(problem)),
      problems.join(" | "),
    );
  });
}

test("every problem is reported, not only the first", () => {
  const problems = problemsOf(
    aConfig({
      accounts: { a: { bank: "nope" } },
      imports: { x: aFormat({ delimiter: "" }) },
    }),
  );
  assert.ok(problems.length >= 3, problems.join(" | "));
});

test("a problem never repeats an account number", () => {
  const problems = problemsOf(
    aConfig({
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001" },
        b: { bank: "bnka", iban: "NL00BNKA0000000001" },
      },
    }),
  );
  assert.ok(problems.every((problem) => !problem.includes("NL00")));
});

test("an IBAN pasted into a bank or used as a key is never repeated", () => {
  const iban = "NL00BNKA0000000001";
  const pasted = problemsOf(aConfig({ accounts: { a: { bank: iban, import_id: "1" } } }));
  assert.ok(pasted.length > 0);
  assert.ok(
    pasted.every((problem) => !problem.includes("NL00")),
    pasted.join(" | "),
  );
  const keyed = problemsOf(
    aConfig({
      accounts: { [iban]: { bank: "bnka", iban }, b: { bank: "bnka", iban } },
      banks: { [iban]: { aspsp: { name: "Example Bank", country: "NL" } } },
      imports: { [iban]: aFormat({ delimiter: "" }) },
    }),
  );
  assert.ok(keyed.length > 0);
  assert.ok(
    keyed.every((problem) => !problem.includes("NL00")),
    keyed.join(" | "),
  );
});

test("an unknown field that could be an account number is never repeated", () => {
  const problems = problemsOf(
    aConfig({
      accounts: { a: { bank: "bnka", iban: "NL00BNKA0000000001", "1001": "x" } as never },
    }),
  );
  assert.deepEqual(problems, ["accounts.a: holds a field the configuration does not know"]);
});

test("namedColumns lists every column a format reads, by the field that reads it", () => {
  assert.deepEqual(namedColumns(aFormat()), [
    ["account", "Account"],
    ["id", "Sequence"],
    ["date", "Booked"],
    ["amount", "Amount"],
    ["currency", "Currency"],
    ["value_date", "Value date"],
    ["counterparty_name", "Counterparty"],
    ["counterparty_account", "Counterparty account"],
    ["code", "Type"],
    ["original_amount", "Original amount"],
    ["original_currency", "Original currency"],
    ["description, column 1", "Text 1"],
    ["description, column 2", "Text 2"],
    ["description, column 3", "Text 3"],
  ]);
});

test("namedColumns leaves out what a format does not name", () => {
  const format = aFormat({ value_date: undefined, description: undefined, code: undefined });
  assert.deepEqual(
    namedColumns(format).map(([field]) => field),
    [
      "account",
      "id",
      "date",
      "amount",
      "currency",
      "counterparty_name",
      "counterparty_account",
      "original_amount",
      "original_currency",
    ],
  );
});

const PEOPLE = {
  mila: { username: "u-mila", password: "hash-1" },
  tom: { username: "u-tom", password: "hash-2" },
};
const withPeople = (value: Record<string, unknown>) => ({ ...aConfig(), ...value });

test("a configuration without people or owners is valid, as before", () => {
  assert.deepEqual(problemsOf(aConfig()), []);
});

test("people and owners are valid when well formed", () => {
  const config = withPeople({
    people: PEOPLE,
    accounts: { a: { bank: "bnka", iban: "NL00BNKA0000000001", owners: ["mila", "tom"] } },
  });
  assert.deepEqual(problemsOf(config), []);
});

test("people refuses", async (t) => {
  const person = (extra: Record<string, unknown>) => ({ mila: { ...PEOPLE.mila, ...extra } });
  const USERNAME_PROBLEM =
    "people, entry 1: username must be 1 to 64 characters of letters, digits, - _ and .";
  const KEY_PROBLEM =
    "people, entry 1: the key may hold only a-z, 0-9 and -, and starts with a letter";
  const cases: Record<string, [Record<string, unknown>, string]> = {
    "a non-object": [{ people: [] }, "people is not an object"],
    "a key with a capital": [{ people: { Mila: PEOPLE.mila } }, KEY_PROBLEM],
    "a key starting with a digit": [{ people: { "1mila": PEOPLE.mila } }, KEY_PROBLEM],
    "an entry that is not an object": [
      { people: { mila: "x" } },
      "people, entry 1: is not an object",
    ],
    "an unknown field": [
      { people: person({ email: "x" }) },
      "people, entry 1: email is not a field the configuration knows",
    ],
    "a missing username": [{ people: { mila: { password: "h" } } }, USERNAME_PROBLEM],
    "a username with a space": [{ people: person({ username: "a b" }) }, USERNAME_PROBLEM],
    "a username of 65 characters": [
      { people: person({ username: "a".repeat(65) }) },
      USERNAME_PROBLEM,
    ],
    "an empty password": [
      { people: person({ password: "" }) },
      "people, entry 1: password must be a non-empty text",
    ],
    "a username two people share": [
      { people: { mila: PEOPLE.mila, tom: { ...PEOPLE.tom, username: "u-mila" } } },
      "people, entry 2: shares its username with people, entry 1",
    ],
  };
  for (const [name, [value, problem]] of Object.entries(cases)) {
    await t.test(name, () => assert.deepEqual(problemsOf(withPeople(value)), [problem]));
  }
});

test("owners refuses", async (t) => {
  const owned = (owners: unknown) =>
    withPeople({
      people: PEOPLE,
      accounts: { a: { bank: "bnka", iban: "NL00BNKA0000000001", owners } },
    });
  const cases: Record<string, [unknown, string]> = {
    "an empty list": [[], "accounts.a: owners must be a non-empty list of names"],
    "a non-list": ["mila", "accounts.a: owners must be a non-empty list of names"],
    "a non-text name": [[1], "accounts.a: owners must be a non-empty list of names"],
    "a repeated name": [["mila", "mila"], "accounts.a: owners names a person twice"],
    "an unknown name": [
      ["mila", "nobody"],
      "accounts.a: owners names a person the configuration does not know",
    ],
  };
  for (const [name, [owners, problem]] of Object.entries(cases)) {
    await t.test(name, () => assert.deepEqual(problemsOf(owned(owners)), [problem]));
  }
});

test("no problem message repeats a username or a person's key", () => {
  const problems = problemsOf(
    withPeople({
      people: {
        zqperson: { username: "zq-user-1", password: "" },
        "Zqperson-2": { username: "zq-user-1", password: "h" },
      },
      accounts: {
        a: { bank: "bnka", iban: "NL00BNKA0000000001", owners: ["zqperson", "zqother"] },
      },
    }),
  );
  assert.ok(problems.length > 0);
  assert.ok(
    problems.every((problem) => !problem.includes("zq")),
    problems.join(" | "),
  );
});
