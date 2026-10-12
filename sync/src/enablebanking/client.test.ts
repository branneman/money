import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, SyncError } from "../errors.ts";
import { makeClient } from "./client.ts";
import type { Fetch } from "./client.ts";

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

// A fetch that answers every request the same way and remembers what it was asked.
const answering = (status: number, body: string) => {
  const calls: Call[] = [];
  const fetch: Fetch = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    return Promise.resolve({ status, text: () => Promise.resolve(body) });
  };
  return { calls, client: makeClient(fetch, "the-token") };
};

test("every request carries the token and goes to the one base address", async () => {
  const { calls, client } = answering(200, '{"transactions":[]}');
  await client.transactionsPage("uid-1", { strategy: "longest" }, null);
  assert.equal(calls[0].method, "GET");
  assert.ok(calls[0].url.startsWith("https://api.enablebanking.com/accounts/uid-1/transactions?"));
  assert.equal(calls[0].headers.authorization, "Bearer the-token");
});

test("no PSU header is ever sent", async () => {
  const { calls, client } = answering(200, '{"transactions":[]}');
  await client.transactionsPage("uid-1", { strategy: "longest" }, null);
  const names = Object.keys(calls[0].headers).map((name) => name.toLowerCase());
  assert.deepEqual(
    names.filter((name) => name.startsWith("psu-")),
    [],
  );
});

test("a backfill asks for booked transactions over the longest period, with no dates", async () => {
  const { calls, client } = answering(200, '{"transactions":[]}');
  await client.transactionsPage("uid-1", { strategy: "longest" }, null);
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), {
    transaction_status: "BOOK",
    strategy: "longest",
  });
});

test("a window fetch sends its two dates, and a later page its continuation key", async () => {
  const { calls, client } = answering(200, '{"transactions":[]}');
  const window = { strategy: "default", dateFrom: "2026-09-11", dateTo: "2026-10-11" } as const;
  await client.transactionsPage("uid-1", window, "key with/odd?characters");
  assert.deepEqual(Object.fromEntries(new URL(calls[0].url).searchParams), {
    transaction_status: "BOOK",
    date_from: "2026-09-11",
    date_to: "2026-10-11",
    continuation_key: "key with/odd?characters",
  });
});

test("a page comes back as the exact text received", async () => {
  const body = '{ "transactions": [ ],\n  "continuation_key": null }';
  const { client } = answering(200, body);
  assert.equal(await client.transactionsPage("uid-1", { strategy: "longest" }, null), body);
});

test("an authorisation asks for a personal consent, for transactions only", async () => {
  const { calls, client } = answering(
    200,
    '{"url":"https://bank.example/approve?authorization=1"}',
  );
  const result = await client.startAuth({
    aspsp: { name: "Example Bank", country: "NL" },
    state: "state-1",
    redirectUrl: "https://localhost/auth-callback",
    validUntil: "2027-04-09T10:00:00Z",
  });
  assert.deepEqual(result, { url: "https://bank.example/approve?authorization=1" });
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, "https://api.enablebanking.com/auth");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].body ?? ""), {
    access: { valid_until: "2027-04-09T10:00:00Z", balances: false, transactions: true },
    aspsp: { name: "Example Bank", country: "NL" },
    state: "state-1",
    redirect_url: "https://localhost/auth-callback",
    psu_type: "personal",
  });
});

test("a session is created from the code", async () => {
  const body = JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000001",
    access: { valid_until: "2027-04-09T10:00:00Z" },
    accounts: [],
  });
  const { calls, client } = answering(200, body);
  assert.equal(
    (await client.createSession("code-1")).sessionId,
    "00000000-0000-4000-8000-000000000001",
  );
  assert.equal(calls[0].url, "https://api.enablebanking.com/sessions");
  assert.deepEqual(JSON.parse(calls[0].body ?? ""), { code: "code-1" });
});

test("the list of banks is asked for by country", async () => {
  const { calls, client } = answering(200, '{"aspsps":[]}');
  assert.equal(await client.findAspsp("Example Bank", "NL"), null);
  assert.equal(calls[0].url, "https://api.enablebanking.com/aspsps?country=NL");
});

test("an error response becomes its status and code, and nothing else of it is kept", async () => {
  const body = JSON.stringify({
    code: 401,
    error: "EXPIRED_SESSION",
    message: "Recognisable message about NL00BNKA0000000001",
    detail: { text: "Recognisable detail" },
  });
  const { client } = answering(401, body);
  await assert.rejects(client.transactionsPage("uid-1", { strategy: "longest" }, null), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "EXPIRED_SESSION");
    assert.equal(error.consentGone, true);
    assert.ok(!JSON.stringify([error.message, error.stack, { ...error }]).includes("Recognisable"));
    return true;
  });
});

test("an error response without a usable code keeps only its status", async () => {
  for (const body of [
    "<html>Bad gateway</html>",
    '{"error":"lower case words"}',
    '{"error":7}',
    "[]",
  ]) {
    const { client } = answering(502, body);
    await assert.rejects(client.findAspsp("Example Bank", "NL"), (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, null);
      assert.equal(error.message, "Enable Banking answered 502");
      return true;
    });
  }
});

test("a request that gets no answer is an expected failure that says so", async () => {
  const fetch: Fetch = () => Promise.reject(new TypeError("fetch failed"));
  await assert.rejects(makeClient(fetch, "t").findAspsp("Example Bank", "NL"), (error) => {
    assert.ok(error instanceof SyncError);
    assert.equal(error.message, "no answer from Enable Banking (TypeError)");
    return true;
  });
});

test("every request has a time limit", async () => {
  let signal: AbortSignal | undefined;
  const fetch: Fetch = (_url, init) => {
    signal = init.signal;
    return Promise.resolve({ status: 200, text: () => Promise.resolve('{"aspsps":[]}') });
  };
  await makeClient(fetch, "t").findAspsp("Example Bank", "NL");
  assert.ok(signal instanceof AbortSignal);
});
