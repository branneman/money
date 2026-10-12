import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { anApiRaw } from "@money/shared/testing";

import { mintToken } from "../src/jwt.ts";
import { makeFakeBank } from "./fake-bank.ts";
import type { FakeAspsp, FakeBank } from "./fake-bank.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const APP_ID = "00000000-0000-4000-8000-00000000aaaa";
const REDIRECT = "https://localhost/auth-callback";
const IBAN = "NL00BNKA0000000001";
const DAY = 86_400_000;

const booked = (id: string, date: string, overrides: Record<string, unknown> = {}) =>
  anApiRaw({ entry_reference: id, booking_date: date, ...overrides });

const setup = (transactions: FakeAspsp["accounts"][number]["transactions"] = []) => {
  const time = { now: new Date("2026-03-01T03:00:00Z") };
  const aspsp: FakeAspsp = {
    name: "Example Bank",
    country: "NL",
    maximumConsentValidity: 180 * 86_400,
    requiredPsuHeaders: ["Psu-Ip-Address"],
    unattendedDays: 90,
    ignoresStatusFilter: false,
    accounts: [
      { iban: IBAN, transactions },
      { iban: "NL00BNKA0000000002", transactions: [] },
    ],
  };
  const bank = makeFakeBank({
    clock: () => time.now,
    publicKey,
    appId: APP_ID,
    redirectUrl: REDIRECT,
    aspsps: [aspsp],
  });
  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const response = await bank.fetch(`https://api.enablebanking.com${path}`, {
      method,
      headers: { authorization: `Bearer ${token ?? mintToken(privateKey, APP_ID, time.now)}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: JSON.parse(await response.text()) as Record<string, unknown>,
    };
  };
  const authorise = async (only?: readonly string[]) => {
    const started = await call("POST", "/auth", {
      access: { valid_until: new Date(time.now.getTime() + 180 * DAY).toISOString() },
      aspsp: { name: "Example Bank", country: "NL" },
      state: "state-1",
      redirect_url: REDIRECT,
    });
    const landed = new URL(bank.approve(String(started.body.url), { only }));
    const session = await call("POST", "/sessions", { code: landed.searchParams.get("code") });
    return { landed, session };
  };
  const uidOf = async (): Promise<string> => {
    const { session } = await authorise();
    return (session.body.accounts as { uid: string }[])[0].uid;
  };
  return { time, aspsp, bank, call, authorise, uidOf };
};

const ids = (body: Record<string, unknown>): string[] =>
  (body.transactions as { entry_reference: string }[]).map((item) => item.entry_reference);

const page = (bank: FakeBank) => bank.requests[bank.requests.length - 1];

test("a request without a valid token is refused", async () => {
  const { call, time } = setup();
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const stale = mintToken(privateKey, APP_ID, new Date(time.now.getTime() - 2 * 3_600_000));
  const tokens = [
    "",
    "not.a.token",
    mintToken(other, APP_ID, time.now),
    mintToken(privateKey, "x", time.now),
    stale,
  ];
  for (const token of tokens) {
    const response = await call("GET", "/aspsps?country=NL", undefined, token);
    assert.equal(response.status, 401);
    assert.equal(response.body.error, "UNAUTHORIZED_ACCESS");
  }
});

test("the list of banks is filtered by country", async () => {
  const { call } = setup();
  const found = await call("GET", "/aspsps?country=NL");
  assert.deepEqual(found.body.aspsps, [
    {
      name: "Example Bank",
      country: "NL",
      maximum_consent_validity: 15_552_000,
      required_psu_headers: ["Psu-Ip-Address"],
    },
  ]);
  assert.deepEqual((await call("GET", "/aspsps?country=BE")).body.aspsps, []);
});

test("an authorisation leads to a session with a uid per account", async () => {
  const { authorise, time } = setup();
  const { landed, session } = await authorise();
  assert.ok(landed.href.startsWith(`${REDIRECT}?`));
  assert.equal(landed.searchParams.get("state"), "state-1");
  assert.equal(session.status, 200);
  const accounts = session.body.accounts as { account_id: { iban: string }; uid: string }[];
  assert.deepEqual(
    accounts.map((account) => account.account_id.iban),
    [IBAN, "NL00BNKA0000000002"],
  );
  assert.notEqual(accounts[0].uid, accounts[1].uid);
  assert.deepEqual(session.body.access, {
    valid_until: new Date(time.now.getTime() + 180 * DAY).toISOString(),
  });
});

test("a consent can cover only some accounts, and a code works once", async () => {
  const { authorise, call } = setup();
  const { landed, session } = await authorise([IBAN]);
  assert.equal((session.body.accounts as unknown[]).length, 1);
  const again = await call("POST", "/sessions", { code: landed.searchParams.get("code") });
  assert.equal(again.status, 400);
  assert.equal(again.body.error, "WRONG_AUTHORIZATION_CODE");
});

test("an authorisation with a wrong bank, redirect or period is refused", async () => {
  const { call, time } = setup();
  const request = (overrides: Record<string, unknown>) =>
    call("POST", "/auth", {
      access: { valid_until: new Date(time.now.getTime() + 180 * DAY).toISOString() },
      aspsp: { name: "Example Bank", country: "NL" },
      state: "state-1",
      redirect_url: REDIRECT,
      ...overrides,
    });
  assert.equal(
    (await request({ aspsp: { name: "Nowhere", country: "NL" } })).body.error,
    "WRONG_ASPSP_PROVIDED",
  );
  assert.equal(
    (await request({ redirect_url: "https://elsewhere.example/" })).body.error,
    "REDIRECT_URI_NOT_ALLOWED",
  );
  const tooLong = { valid_until: new Date(time.now.getTime() + 181 * DAY).toISOString() };
  assert.equal((await request({ access: tooLong })).body.error, "WRONG_REQUEST_PARAMETERS");
  assert.equal((await request({ state: "" })).body.error, "WRONG_REQUEST_PARAMETERS");
});

test("transactions come in pages, in order, under keys the bank checks", async () => {
  const history = ["c", "a", "e", "b", "d"].map((id) => [
    { from: "2026-01-01T00:00:00Z", raw: booked(id, "2026-02-10") },
  ]);
  const { bank, call, uidOf } = setup(history);
  const uid = await uidOf();
  bank.pageSize = 2;
  const first = await call("GET", `/accounts/${uid}/transactions?strategy=longest`);
  assert.deepEqual(ids(first.body), ["a", "b"]);
  const key = String(first.body.continuation_key);
  const second = await call(
    "GET",
    `/accounts/${uid}/transactions?strategy=longest&continuation_key=${key}`,
  );
  assert.deepEqual(ids(second.body), ["c", "d"]);
  const third = await call(
    "GET",
    `/accounts/${uid}/transactions?strategy=longest&continuation_key=${String(second.body.continuation_key)}`,
  );
  assert.deepEqual(ids(third.body), ["e"]);
  assert.equal(third.body.continuation_key, null);
  assert.deepEqual(page(bank).query, {
    strategy: "longest",
    continuation_key: String(second.body.continuation_key),
  });

  const wrong = await call("GET", `/accounts/${uid}/transactions?continuation_key=nonsense`);
  assert.equal(wrong.body.error, "WRONG_CONTINUATION_KEY");
  assert.equal(bank.served.length, 5);
  assert.equal(bank.served[0].iban, IBAN);
});

test("a window is inclusive at both ends, and the status filter is honoured", async () => {
  const { call, uidOf, aspsp } = setup([
    [{ from: "2026-01-01T00:00:00Z", raw: booked("before", "2026-02-09") }],
    [{ from: "2026-01-01T00:00:00Z", raw: booked("first", "2026-02-10") }],
    [{ from: "2026-01-01T00:00:00Z", raw: booked("last", "2026-02-20") }],
    [{ from: "2026-01-01T00:00:00Z", raw: booked("after", "2026-02-21") }],
    [{ from: "2026-01-01T00:00:00Z", raw: booked("pending", "2026-02-15", { status: "PDNG" }) }],
  ]);
  const uid = await uidOf();
  const window = "date_from=2026-02-10&date_to=2026-02-20";
  const filtered = await call(
    "GET",
    `/accounts/${uid}/transactions?${window}&transaction_status=BOOK`,
  );
  assert.deepEqual(ids(filtered.body), ["first", "last"]);
  const all = await call("GET", `/accounts/${uid}/transactions?${window}`);
  assert.deepEqual(ids(all.body), ["first", "pending", "last"]);
  aspsp.ignoresStatusFilter = true;
  const ignored = await call(
    "GET",
    `/accounts/${uid}/transactions?${window}&transaction_status=BOOK`,
  );
  assert.deepEqual(ids(ignored.body), ["first", "pending", "last"]);
});

test("a fresh session reaches all history, an older one only the unattended period", async () => {
  const { call, uidOf, time } = setup([
    [{ from: "2020-01-01T00:00:00Z", raw: booked("old", "2024-06-01") }],
    [{ from: "2020-01-01T00:00:00Z", raw: booked("recent", "2026-02-20") }],
  ]);
  const uid = await uidOf();
  const longest = `/accounts/${uid}/transactions?strategy=longest`;
  assert.deepEqual(ids((await call("GET", longest)).body), ["old", "recent"]);
  assert.deepEqual(
    ids((await call("GET", `${longest}&date_from=2026-01-01&date_to=2026-01-02`)).body),
    ["recent"],
  );

  time.now = new Date(time.now.getTime() + 2 * 3_600_000);
  assert.deepEqual(ids((await call("GET", longest)).body), ["recent"]);
  const tooFar = await call(
    "GET",
    `/accounts/${uid}/transactions?date_from=2024-01-01&date_to=2026-03-01`,
  );
  assert.equal(tooFar.status, 422);
  assert.equal(tooFar.body.error, "WRONG_TRANSACTIONS_PERIOD");
});

test("the bank answers with each transaction's version at that time", async () => {
  const { call, uidOf, time } = setup([
    [
      { from: "2026-03-02T00:00:00Z", raw: booked("a", "2026-03-01", { note: "first" }) },
      { from: "2026-03-04T00:00:00Z", raw: booked("a", "2026-03-01", { note: "second" }) },
      { from: "2026-03-06T00:00:00Z", raw: null },
    ],
  ]);
  const uid = await uidOf();
  const notes = async (): Promise<unknown[]> => {
    const response = await call(
      "GET",
      `/accounts/${uid}/transactions?date_from=2026-02-01&date_to=2026-12-31`,
    );
    return (response.body.transactions as { note: string }[]).map((item) => item.note);
  };
  assert.deepEqual(await notes(), []);
  time.now = new Date("2026-03-03T03:00:00Z");
  assert.deepEqual(await notes(), ["first"]);
  time.now = new Date("2026-03-05T03:00:00Z");
  assert.deepEqual(await notes(), ["second"]);
  time.now = new Date("2026-03-07T03:00:00Z");
  assert.deepEqual(await notes(), []);
});

test("a session ends when it expires or is revoked, and an unknown account does not exist", async () => {
  const { bank, call, uidOf, time } = setup();
  const uid = await uidOf();
  const path = `/accounts/${uid}/transactions?strategy=longest`;
  assert.equal(
    (await call("GET", "/accounts/nobody/transactions")).body.error,
    "ACCOUNT_DOES_NOT_EXIST",
  );
  bank.revoke("Example Bank");
  assert.equal((await call("GET", path)).body.error, "REVOKED_SESSION");

  const other = await uidOf();
  time.now = new Date(time.now.getTime() + 180 * DAY);
  const expired = await call("GET", `/accounts/${other}/transactions?strategy=longest`);
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error, "EXPIRED_SESSION");
});

test("a chosen request can be made to fail, in each of three ways", async () => {
  const { bank, call } = setup();
  bank.failRequest(2, { status: 500, error: "ASPSP_ERROR" });
  assert.equal((await call("GET", "/aspsps?country=NL")).status, 200);
  const failed = await call("GET", "/aspsps?country=NL");
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "ASPSP_ERROR");
  assert.match(String(failed.body.message), /Recognisable/);
  assert.equal((await call("GET", "/aspsps?country=NL")).status, 200);

  bank.failRequest(1, { network: true });
  await assert.rejects(call("GET", "/aspsps?country=NL"), TypeError);

  bank.failRequest(1, { body: '{"odd":true}' });
  assert.deepEqual((await call("GET", "/aspsps?country=NL")).body, { odd: true });

  bank.failRequest(1, { network: true });
  bank.clearFailures();
  assert.equal((await call("GET", "/aspsps?country=NL")).status, 200);
});

test("every request is recorded, with lower-case header names", async () => {
  const { bank, call } = setup();
  await call("GET", "/aspsps?country=NL");
  assert.equal(bank.requests.length, 1);
  assert.equal(bank.requests[0].method, "GET");
  assert.equal(bank.requests[0].path, "/aspsps");
  assert.deepEqual(bank.requests[0].query, { country: "NL" });
  assert.match(bank.requests[0].headers.authorization, /^Bearer /);
});

const threeInOrder = (extra: Record<string, unknown> = {}) =>
  ["a", "b", "c"].map((id) => [
    { from: "2026-01-01T00:00:00Z", raw: booked(id, "2026-02-10", extra) },
  ]);

test("a continuation key works only for the account and query it was issued for", async () => {
  const { bank, call, authorise } = setup(threeInOrder());
  const { session } = await authorise();
  const [uid, otherUid] = (session.body.accounts as { uid: string }[]).map((item) => item.uid);
  bank.pageSize = 1;
  const base = `/accounts/${uid}/transactions?strategy=longest`;
  const first = await call("GET", base);
  const key = String(first.body.continuation_key);
  const refused = async (path: string) => {
    const response = await call("GET", path);
    assert.equal(response.status, 400);
    assert.equal(response.body.error, "WRONG_CONTINUATION_KEY");
  };
  await refused(`/accounts/${uid}/transactions?continuation_key=${key}`);
  await refused(`${base}&date_from=2026-01-01&continuation_key=${key}`);
  await refused(`/accounts/${otherUid}/transactions?strategy=longest&continuation_key=${key}`);
  await refused(`${base}&continuation_key=k-0-${Date.UTC(2027, 0, 1)}`);
  await refused(`${base}&continuation_key=k-99-${key.split("-")[2]}`);
  assert.equal((await call("GET", `${base}&continuation_key=${key}`)).status, 200);
});

test("pages are one list as it stood at the first page, however the clock and the bank move", async () => {
  const { bank, call, uidOf, time } = setup([
    [{ from: "2020-01-01T00:00:00Z", raw: booked("old", "2024-06-01") }],
    [
      { from: "2020-01-01T00:00:00Z", raw: booked("a", "2026-02-10") },
      { from: "2026-03-01T03:30:00Z", raw: null },
    ],
    [{ from: "2020-01-01T00:00:00Z", raw: booked("b", "2026-02-11") }],
  ]);
  const uid = await uidOf();
  bank.pageSize = 1;
  const path = `/accounts/${uid}/transactions?strategy=longest`;
  const first = await call("GET", path);
  assert.deepEqual(ids(first.body), ["old"]);
  time.now = new Date(time.now.getTime() + 61 * 60_000);
  const second = await call(
    "GET",
    `${path}&continuation_key=${String(first.body.continuation_key)}`,
  );
  assert.deepEqual(ids(second.body), ["a"]);
  const third = await call(
    "GET",
    `${path}&continuation_key=${String(second.body.continuation_key)}`,
  );
  assert.deepEqual(ids(third.body), ["b"]);
  assert.equal(third.body.continuation_key, null);
});

test("pages do not shift when the reach moves across midnight", async () => {
  const { bank, call, uidOf, time } = setup([
    [{ from: "2020-01-01T00:00:00Z", raw: booked("x", "2025-12-01") }],
    [{ from: "2020-01-01T00:00:00Z", raw: booked("y", "2026-02-10") }],
    [{ from: "2020-01-01T00:00:00Z", raw: booked("z", "2026-02-11") }],
  ]);
  const uid = await uidOf();
  bank.pageSize = 1;
  time.now = new Date("2026-03-01T23:30:00Z");
  const path = `/accounts/${uid}/transactions?strategy=longest`;
  const first = await call("GET", path);
  assert.deepEqual(ids(first.body), ["x"]);
  time.now = new Date("2026-03-02T00:30:00Z");
  const second = await call(
    "GET",
    `${path}&continuation_key=${String(first.body.continuation_key)}`,
  );
  assert.deepEqual(ids(second.body), ["y"]);
  const third = await call(
    "GET",
    `${path}&continuation_key=${String(second.body.continuation_key)}`,
  );
  assert.deepEqual(ids(third.body), ["z"]);
});

test("query parameters the bank does not know or understand are refused", async () => {
  const { call, uidOf } = setup(threeInOrder());
  const uid = await uidOf();
  const base = `/accounts/${uid}/transactions`;
  const wrong = async (query: string, error = "WRONG_REQUEST_PARAMETERS") => {
    const response = await call("GET", `${base}?${query}`);
    assert.equal(response.status, 422, query);
    assert.equal(response.body.error, error, query);
  };
  await wrong("date_form=2026-02-01");
  await wrong("strategy=longst");
  await wrong("transaction_status=BOOKED");
  await wrong("date_from=yesterday");
  await wrong("date_to=2026-2-28");
  await wrong("date_to=2026-02-30");
  await wrong("date_from=2026-02-20&date_to=2026-02-10", "WRONG_TRANSACTIONS_PERIOD");
  assert.equal((await call("GET", `${base}?strategy=default&transaction_status=PDNG`)).status, 200);
});

test("failRequest needs a positive whole number", () => {
  const { bank } = setup();
  for (const n of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => bank.failRequest(n, { network: true }));
  }
});

test("a body that is not JSON is a bad request, not a broken connection", async () => {
  const { bank, time } = setup();
  const response = await bank.fetch("https://api.enablebanking.com/auth", {
    method: "POST",
    headers: { authorization: `Bearer ${mintToken(privateKey, APP_ID, time.now)}` },
    body: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal(
    (JSON.parse(await response.text()) as { error: string }).error,
    "WRONG_REQUEST_PARAMETERS",
  );
});

test("two first pages in the same instant get keys of their own", async () => {
  const { aspsp, bank, call, uidOf } = setup(threeInOrder({ note: "old" }));
  const uid = await uidOf();
  bank.pageSize = 1;
  const path = `/accounts/${uid}/transactions?strategy=longest`;
  const notes = (body: Record<string, unknown>) =>
    (body.transactions as { note: string }[]).map((item) => item.note);
  const firstRun = await call("GET", path);
  aspsp.accounts[0].transactions[1].push({
    from: "2026-03-01T03:00:00Z",
    raw: booked("b", "2026-02-10", { note: "new" }),
  });
  const secondRun = await call("GET", path);
  assert.notEqual(firstRun.body.continuation_key, secondRun.body.continuation_key);
  const more = (run: { body: Record<string, unknown> }) =>
    call("GET", `${path}&continuation_key=${String(run.body.continuation_key)}`);
  assert.deepEqual(notes((await more(secondRun)).body), ["new"]);
  assert.deepEqual(notes((await more(firstRun)).body), ["old"]);
});
