import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { loadServerConfig } from "./server-config.ts";

const fixtures = readFileSync(new URL("../../fixtures/config.json", import.meta.url), "utf8");

test("text that is not JSON is refused, without quoting the parser", () => {
  const result = loadServerConfig('{ "secret-looking": oops');
  assert.deepEqual(result, { ok: false, problems: ["the configuration file is not valid JSON"] });
});

test("a sync-only file without people is refused by the server's check", () => {
  // A sync-only file has neither people nor owners.
  const syncOnly = JSON.parse(fixtures) as {
    people?: unknown;
    accounts: Record<string, { owners?: unknown }>;
  };
  delete syncOnly.people;
  for (const account of Object.values(syncOnly.accounts)) delete account.owners;
  const result = loadServerConfig(JSON.stringify(syncOnly));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(result.problems.includes("people names no one"));
});

test("the fixtures' configuration is accepted with two people", () => {
  const result = loadServerConfig(fixtures);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.people.length, 2);
});
