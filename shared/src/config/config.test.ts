import assert from "node:assert/strict";
import { test } from "node:test";

import { aConfig, aFormat } from "../../testing/factories.ts";
import { validateConfig } from "./config.ts";

const problemsOf = (value: unknown): string[] => {
  const result = validateConfig(value);
  return result.ok ? [] : result.problems;
};

test("a valid configuration passes and comes back typed", () => {
  const result = validateConfig(structuredClone(aConfig()));
  assert.ok(result.ok);
  assert.deepEqual(result.ok && result.config, aConfig());
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
    /accounts\.Bnka Current: the key/,
  ],
  [
    "an account at an unknown bank",
    aConfig({ accounts: { a: { bank: "nope", iban: "NL00BNKA0000000001" } } }),
    /accounts\.a: bank nope is not configured/,
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
