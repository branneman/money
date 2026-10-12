import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { SyncError } from "./errors.ts";
import { readState, renewed, withSuccess, writeState } from "./state.ts";
import type { BankState } from "./state.ts";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "money-state-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const state = (): BankState => ({
  session_id: "00000000-0000-4000-8000-000000000001",
  valid_until: "2027-04-09T10:00:00Z",
  accounts: {
    "bnka-current": {
      uid: "00000000-0000-4000-8000-000000000002",
      last_success: "2026-10-11T03:00:00Z",
      missing: ["ref-9"],
    },
    "bnka-joint": { uid: "00000000-0000-4000-8000-000000000003", missing: [] },
  },
});

test("a bank that was never authorised has no state", async () => {
  assert.equal(await readState(dir, "bnka"), null);
});

test("what is written can be read back, and no temporary file is left", async () => {
  await writeState(dir, "bnka", state());
  assert.deepEqual(await readState(dir, "bnka"), state());
  assert.deepEqual(await readdir(dir), ["bnka.json"]);
  assert.ok((await readFile(join(dir, "bnka.json"), "utf8")).endsWith("}\n"));
});

const broken: [string, unknown][] = [
  ["a list", []],
  ["no session", { ...state(), session_id: "" }],
  ["an expiry in another notation", { ...state(), valid_until: "2027-04-09" }],
  ["accounts that are not an object", { ...state(), accounts: [] }],
  [
    "an account key that is not a key",
    { ...state(), accounts: { "Not A Key": { uid: "u", missing: [] } } },
  ],
  ["an account without a uid", { ...state(), accounts: { "bnka-current": { missing: [] } } }],
  [
    "a success in another notation",
    {
      ...state(),
      accounts: { "bnka-current": { uid: "u", last_success: "yesterday", missing: [] } },
    },
  ],
  [
    "missing that is not a list of ids",
    { ...state(), accounts: { "bnka-current": { uid: "u", missing: [7] } } },
  ],
  ["no list of missing ids", { ...state(), accounts: { "bnka-current": { uid: "u" } } }],
];

for (const [name, value] of broken) {
  test(`stored state with ${name} is refused`, async () => {
    await writeFile(join(dir, "bnka.json"), JSON.stringify(value));
    await assert.rejects(readState(dir, "bnka"), (error: unknown) => {
      assert.ok(error instanceof SyncError);
      assert.equal(
        error.message,
        "the stored state of bnka is not what the sync wrote. Remove it and run: auth bnka",
      );
      return true;
    });
  });
}

test("stored state that is not JSON is refused the same way", async () => {
  await writeFile(join(dir, "bnka.json"), "{ half a fi");
  await assert.rejects(readState(dir, "bnka"), SyncError);
});

test("a first authorisation gives each account its uid and nothing else", () => {
  const session = { sessionId: "s-1", validUntil: "2027-04-09T10:00:00Z" };
  assert.deepEqual(renewed(null, session, { "bnka-joint": "u-2", "bnka-current": "u-1" }), {
    session_id: "s-1",
    valid_until: "2027-04-09T10:00:00Z",
    accounts: {
      "bnka-current": { uid: "u-1", missing: [] },
      "bnka-joint": { uid: "u-2", missing: [] },
    },
  });
});

test("a renewal replaces the session and uids, and keeps what each account had reached", () => {
  const session = { sessionId: "s-2", validUntil: "2027-10-06T10:00:00Z" };
  const result = renewed(state(), session, { "bnka-current": "u-new" });
  assert.deepEqual(result, {
    session_id: "s-2",
    valid_until: "2027-10-06T10:00:00Z",
    accounts: {
      "bnka-current": { uid: "u-new", last_success: "2026-10-11T03:00:00Z", missing: ["ref-9"] },
    },
  });
});

test("a success is recorded for one account and leaves the others alone", () => {
  const result = withSuccess(state(), "bnka-joint", "2026-10-12T03:00:00Z", ["ref-3"]);
  assert.deepEqual(result.accounts["bnka-joint"], {
    uid: "00000000-0000-4000-8000-000000000003",
    last_success: "2026-10-12T03:00:00Z",
    missing: ["ref-3"],
  });
  assert.deepEqual(result.accounts["bnka-current"], state().accounts["bnka-current"]);
  assert.equal(result.session_id, state().session_id);
});
