import assert from "node:assert/strict";
import { test } from "node:test";

import type { Config } from "@money/shared";

import { SCRYPT, formatHash } from "./auth/password.ts";
import { findByUsername, peopleOf, serverConfigProblems, visibleAccounts } from "./people.ts";

const hash = (overrides: { N?: number } = {}): string =>
  formatHash({
    N: overrides.N ?? SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: Buffer.alloc(SCRYPT.saltBytes, 1),
    key: Buffer.alloc(SCRYPT.keyBytes, 2),
  });

const config = (overrides: Partial<Config> = {}): Config => ({
  banks: { bnka: { aspsp: { name: "Example Bank", country: "NL" } } },
  people: {
    mila: { username: "u-mila", password: hash() },
    tom: { username: "u-tom", password: hash() },
  },
  accounts: {
    "bnka-a": { bank: "bnka", iban: "NL00BNKA0000000001", owners: ["mila"] },
    "bnka-b": { bank: "bnka", iban: "NL00BNKA0000000002", owners: ["tom", "mila"] },
    "bnka-c": { bank: "bnka", iban: "NL00BNKA0000000003", owners: ["tom"], closed: true },
  },
  imports: {},
  ...overrides,
});

test("a configuration with people and owners satisfies the server", () => {
  assert.deepEqual(serverConfigProblems(config()), []);
});

test("serverConfigProblems names no one when there is no people section", () => {
  assert.deepEqual(serverConfigProblems(config({ people: undefined })), ["people names no one"]);
});

test("serverConfigProblems names an account with no owner, closed or not", () => {
  const problems = serverConfigProblems(
    config({
      accounts: {
        "bnka-a": { bank: "bnka", iban: "NL00BNKA0000000001" },
        "bnka-c": { bank: "bnka", iban: "NL00BNKA0000000003", closed: true },
      },
    }),
  );
  assert.deepEqual(problems, [
    "accounts.bnka-a: names no owner",
    "accounts.bnka-c: names no owner",
  ]);
});

test("serverConfigProblems refuses a malformed hash, by position", () => {
  const problems = serverConfigProblems(
    config({ people: { zqperson: { username: "zq-user", password: "hunter2" } } }),
  );
  assert.deepEqual(problems, ["people, entry 1: password is not a hash money hash-password made"]);
});

test("serverConfigProblems refuses a weak hash, by position", () => {
  const problems = serverConfigProblems(
    config({
      people: {
        mila: { username: "u-mila", password: hash() },
        zqperson: { username: "zq-user", password: hash({ N: 65536 }) },
      },
    }),
  );
  assert.deepEqual(problems, ["people, entry 2: password hash is weaker than this server accepts"]);
});

test("peopleOf lists each person with a parsed hash", () => {
  const people = peopleOf(config());
  assert.deepEqual(
    people.map((person) => [person.key, person.username]),
    [
      ["mila", "u-mila"],
      ["tom", "u-tom"],
    ],
  );
  assert.equal(people[0].password.N, SCRYPT.N);
});

test("findByUsername finds an exact match", () => {
  const people = peopleOf(config());
  assert.equal(findByUsername(people, "u-tom")?.key, "tom");
});

test("findByUsername refuses another case, a leading space and a person's key", () => {
  const people = peopleOf(config());
  assert.equal(findByUsername(people, "U-TOM"), null);
  assert.equal(findByUsername(people, " u-tom"), null);
  assert.equal(findByUsername(people, "tom"), null);
});

test("visibleAccounts lists the accounts a person owns, sorted", () => {
  assert.deepEqual(visibleAccounts(config(), "mila"), ["bnka-a", "bnka-b"]);
  assert.deepEqual(visibleAccounts(config(), "tom"), ["bnka-b", "bnka-c"]);
});

test("visibleAccounts is empty for a person who owns nothing", () => {
  assert.deepEqual(visibleAccounts(config(), "nobody"), []);
});
