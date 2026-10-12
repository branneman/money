import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";

import {
  booked,
  CRASHED,
  makeWorld,
  REDIRECT_URL,
  worldAspsps,
  worldConfig,
} from "../../testing/world.ts";
import type { World } from "../../testing/world.ts";

const IBAN = "NL00BNKA0000000001";
const JOINT = "NL00BNKA0000000002";

const start = async (
  t: TestContext,
  options: Parameters<typeof makeWorld>[0] = {},
): Promise<World> => {
  const world = await makeWorld(options);
  t.after(world.cleanup);
  return world;
};
const printed = (world: World): string => world.lines.join("\n");
const paths = (world: World): string[] =>
  world.bank.requests.map(
    (request) => `${request.method} ${request.path.replace(/\/accounts\/[^/]+/, "/accounts/uid")}`,
  );

test("a first authorisation stores the session and fetches every account's whole history", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("old", "2024-06-01"));
  world.add(IBAN, booked("new", "2026-02-20"));
  world.add(JOINT, booked("j", "2026-02-20"));

  assert.equal(await world.run("auth", "bnka"), 0);
  assert.deepEqual(paths(world), [
    "GET /aspsps",
    "POST /auth",
    "POST /sessions",
    "GET /accounts/uid/transactions",
    "GET /accounts/uid/transactions",
  ]);
  assert.deepEqual(JSON.parse(world.bank.requests[1].body ?? ""), {
    access: { valid_until: "2026-08-28T03:00:00Z", balances: false, transactions: true },
    aspsp: { name: "Example Bank", country: "NL" },
    state: "state-from-the-test",
    redirect_url: REDIRECT_URL,
    psu_type: "personal",
  });
  assert.deepEqual(world.transactionRequests()[0].query, {
    transaction_status: "BOOK",
    strategy: "longest",
  });

  const state = await world.state("bnka");
  assert.equal(state?.valid_until, "2026-08-28T03:00:00Z");
  // The card has no IBAN and the old account is closed: neither is in the state.
  assert.deepEqual(Object.keys(state?.accounts ?? {}), ["bnka-current", "bnka-joint"]);
  assert.equal(state?.accounts["bnka-current"].last_success, "2026-03-01T03:00:00Z");
  assert.deepEqual(
    (await world.records("bnka-current")).map((record) => record.id),
    ["old", "new"],
  );
  assert.equal((await world.records("bnka-joint")).length, 1);
  assert.match(printed(world), /authorised bank=bnka accounts=2 ignored=1 until=2026-08-28/);
  assert.match(printed(world), /PSU headers this bank lists as required: none/);
  assert.deepEqual(await readdir(world.stateDir), ["bnka.json"]);
});

test("the headers a bank lists as required are printed by name", async (t) => {
  const aspsps = worldAspsps();
  aspsps[0].requiredPsuHeaders = ["Psu-Ip-Address", "Psu-User-Agent"];
  const world = await start(t, { aspsps });
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.match(
    printed(world),
    /PSU headers this bank lists as required: Psu-Ip-Address, Psu-User-Agent/,
  );
});

test("an IBAN written with spaces or in lower case still finds its account", async (t) => {
  const config = worldConfig();
  config.accounts["bnka-current"] = { bank: "bnka", iban: "nl00 bnka 0000 0000 01" };
  const world = await start(t, { config });
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.ok((await world.state("bnka"))?.accounts["bnka-current"].uid);
});

test("a pasted address with another state stores nothing and exchanges nothing", async (t) => {
  const world = await start(t);
  world.paste = (url) => world.bank.approve(url).replace("state-from-the-test", "another-state");
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /its state does not match/);
  assert.equal(await world.state("bnka"), null);
  assert.deepEqual(paths(world), ["GET /aspsps", "POST /auth"]);
});

test("a consent the user cancelled at the bank stores nothing", async (t) => {
  const world = await start(t);
  world.paste = () => `${REDIRECT_URL}?error=access_denied&state=state-from-the-test`;
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /the bank did not grant the consent \(access_denied\)/);
  assert.equal(await world.state("bnka"), null);
});

test("a configured account the consent does not cover is an error that names it", async (t) => {
  const world = await start(t);
  world.paste = (url) => world.bank.approve(url, { only: [IBAN] });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /bnka-joint: the consent does not cover it/);
  assert.equal(await world.state("bnka"), null);
  assert.equal(world.transactionRequests().length, 0);
});

test("a renewal replaces the session and fetches from the last success, not the whole history", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);
  const before = await world.state("bnka");

  world.at("2026-03-10T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-09"));
  world.bank.requests.length = 0;
  assert.equal(await world.run("auth", "bnka"), 0);
  const after = await world.state("bnka");
  assert.notEqual(after?.session_id, before?.session_id);
  assert.notEqual(after?.accounts["bnka-current"].uid, before?.accounts["bnka-current"].uid);
  assert.equal(after?.accounts["bnka-current"].last_success, "2026-03-10T03:00:00Z");
  assert.deepEqual(world.transactionRequests()[0].query, {
    transaction_status: "BOOK",
    date_from: "2026-01-30",
    date_to: "2026-03-10",
  });
  assert.deepEqual(
    (await world.records("bnka-current")).map((record) => record.id),
    ["a", "b"],
  );
});

test("after the state is lost, a completed run left in the inbox does not stand in for the whole history", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);

  // A renewal receives a whole window and dies before merging it. Then the state is lost.
  world.at("2026-03-10T03:00:00Z");
  world.crashAt = "received";
  assert.equal(await world.run("auth", "bnka"), CRASHED);
  assert.ok((await world.inbox("bnka-current"))[0].marker);
  await rm(join(world.stateDir, "bnka.json"));

  // The run left behind is merged and records its own start, and the whole history is
  // still asked for: the state said nothing about this account when auth began.
  world.at("2026-03-11T03:00:00Z");
  world.bank.requests.length = 0;
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.deepEqual(world.transactionRequests()[0].query, {
    transaction_status: "BOOK",
    strategy: "longest",
  });
  assert.equal(
    (await world.state("bnka"))?.accounts["bnka-current"].last_success,
    "2026-03-11T03:00:00Z",
  );
});

test("a backfill that dies keeps the session and what arrived, and says how to continue", async (t) => {
  const world = await start(t);
  for (const id of ["a", "b", "c"]) world.add(IBAN, booked(id, "2026-02-20"));
  world.add(JOINT, booked("j", "2026-02-20"));
  world.bank.pageSize = 2;
  // Requests: the bank list, the authorisation, the session, then the first account's
  // first page. The fifth is its second page.
  world.bank.failRequest(5, { status: 500, error: "ASPSP_ERROR" });

  assert.equal(await world.run("auth", "bnka"), 1);
  const state = await world.state("bnka");
  assert.ok(state?.session_id);
  assert.equal(state?.accounts["bnka-current"].last_success, undefined);
  assert.equal(state?.accounts["bnka-joint"].last_success, "2026-03-01T03:00:00Z");
  assert.equal((await world.inbox("bnka-current"))[0].pages.length, 1);
  assert.match(
    printed(world),
    /The consent is stored\. Not fetched in full: bnka-current\. Run sync to continue\./,
  );
});

test("a bank that is not configured is refused without repeating what was typed", async (t) => {
  const world = await start(t);
  assert.equal(await world.run("auth", "nowhere"), 1);
  assert.match(printed(world), /that bank is not in the configuration/);
  assert.ok(!printed(world).includes("nowhere"));
  assert.equal(world.bank.requests.length, 0);
});

test("a bank Enable Banking does not list under the configured name is reported", async (t) => {
  const aspsps = worldAspsps();
  aspsps[0].name = "Renamed Example Bank";
  const world = await start(t, { aspsps });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(
    printed(world),
    /bnka: Enable Banking lists no bank under the configured name and country/,
  );
  assert.deepEqual(paths(world), ["GET /aspsps"]);
});

test("stored state the sync did not write stops auth before the user is sent to the bank", async (t) => {
  const world = await start(t);
  await writeFile(join(world.stateDir, "bnka.json"), "{ half a fi");
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /the stored state of bnka is not what the sync wrote/);
  assert.equal(world.bank.requests.length, 0);
});

test("anything but a known command prints the usage", async (t) => {
  const world = await start(t);
  for (const argv of [[], ["auth"], ["auth", "bnka", "extra"], ["transfer"]]) {
    world.lines.length = 0;
    assert.equal(await world.run(...argv), 1);
    assert.match(printed(world), /^usage: /);
  }
  assert.equal(world.bank.requests.length, 0);
});

test("a problem in the environment stops the command before any request", async (t) => {
  const world = await start(t);
  delete world.env.EB_APP_ID;
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(printed(world), "EB_APP_ID is not set");
  assert.equal(world.bank.requests.length, 0);
});

test("a lock held by a live run stops auth, and a finished auth leaves no lock", async (t) => {
  const world = await start(t);
  await writeFile(join(world.stateDir, "lock"), "999\n");
  world.alive.add(999);
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /another run holds the lock in STATE_DIR/);
  assert.equal(world.bank.requests.length, 0);

  world.alive.clear();
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.deepEqual(await readdir(world.stateDir), ["bnka.json"]);
});

test("an error nobody expected stops the run, prints only its class and code, and frees the lock", async (t) => {
  const world = await start(t);
  // A file where the account's inbox directory belongs.
  await mkdir(join(world.dataDir, ".inbox"));
  await writeFile(join(world.dataDir, ".inbox", "bnka-current"), "Recognisable contents");
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(world.lines[world.lines.length - 1], "unexpected Error ENOTDIR");
  assert.ok(!printed(world).includes(world.dataDir));
  assert.ok(!(await readdir(world.stateDir)).includes("lock"));
});
