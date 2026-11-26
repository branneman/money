import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, readdir, rm, writeFile } from "node:fs/promises";
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
import { SyncError } from "../errors.ts";

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
const deletes = (world: World): string[] =>
  world.bank.requests.filter((request) => request.method === "DELETE").map((r) => r.path);
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
  // A first authorisation has nothing to close.
  assert.equal(deletes(world).length, 0);
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

test("an open account with fetch false need not be in the consent, and is not fetched", async (t) => {
  const config = worldConfig();
  config.accounts["bnka-joint"] = { bank: "bnka", iban: JOINT, fetch: false };
  const world = await start(t, { config });
  world.paste = (url) => world.bank.approve(url, { only: [IBAN] });
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.ok(!printed(world).includes("bnka-joint"));
  assert.deepEqual(Object.keys((await world.state("bnka"))?.accounts ?? {}), ["bnka-current"]);
  assert.equal(world.transactionRequests().length, 1);
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
  // Counts only: enough to tell a wrong iban from a bank that gives none.
  assert.match(printed(world), /The consent holds 1 account\(s\), 1 of them with an iban\./);
  assert.equal(await world.state("bnka"), null);
  assert.equal(world.transactionRequests().length, 0);
  // The session was made before the accounts were matched, so it is closed again.
  // The fake answers 200 only for a session it issued and has not closed, and this is the
  // only one it issued.
  assert.equal(deletes(world).length, 1);
  assert.match(deletes(world)[0], /^\/sessions\/[^/]+$/);
  assert.match(printed(world), /\nThe consent just given was closed again\.$/);
});

test("a refused session the bank will not close says so, and still fails", async (t) => {
  const world = await start(t);
  world.paste = (url) => world.bank.approve(url, { only: [IBAN] });
  // Requests: the bank list, the authorisation, the session, then the close.
  world.bank.failRequest(4, { status: 404, error: "SESSION_DOES_NOT_EXIST" });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(deletes(world).length, 1);
  assert.match(
    printed(world),
    /\nThe consent just given was not closed, and ends by itself on 2026-08-28: Enable Banking answered 404 SESSION_DOES_NOT_EXIST\.$/,
  );
  assert.ok(!printed(world).includes("was closed again"));
  assert.equal(await world.state("bnka"), null);
});

test("auth --show-ibans prints the ibans the consent holds, and only when asked", async (t) => {
  const world = await start(t);
  world.paste = (url) => world.bank.approve(url, { only: [IBAN] });
  assert.equal(await world.run("auth", "bnka", "--show-ibans"), 1);
  assert.match(printed(world), new RegExp(`The consent holds these ibans:\\n  "${IBAN}"\\n`));
  assert.match(printed(world), /bnka-joint: the consent does not cover it/);
  world.lines.length = 0;
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.ok(!printed(world).includes(IBAN));
});

test("auth takes no other option", async (t) => {
  const world = await start(t);
  assert.equal(await world.run("auth", "bnka", "--show"), 1);
  assert.match(printed(world), /^usage: /);
  assert.equal(world.bank.requests.length, 0);
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

test("a renewal closes the session it replaced, and sync then fetches through the new one", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);
  const old = (await world.state("bnka"))?.session_id;
  assert.equal(deletes(world).length, 0);

  world.at("2026-03-02T03:00:00Z");
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.deepEqual(deletes(world), [`/sessions/${old}`]);
  assert.match(printed(world), /^previous-closed bank=bnka$/m);

  world.at("2026-03-03T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-02"));
  // The other bank was never authorised, which is the only reason this run fails.
  world.lines.length = 0;
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^failed: bnkb$/m);
  assert.deepEqual(
    (await world.records("bnka-current")).map((record) => record.id),
    ["a", "b"],
  );
});

test("a renewal returning the same session id closes nothing, and sync still fetches through it", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);
  const before = (await world.state("bnka"))?.session_id;

  world.at("2026-03-02T03:00:00Z");
  world.paste = (url) => world.bank.approve(url, { same: true });
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal((await world.state("bnka"))?.session_id, before);
  assert.equal(deletes(world).length, 0);
  assert.ok(!printed(world).includes("previous-closed"));
  assert.ok(!printed(world).includes("was not closed"));

  world.at("2026-03-03T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-02"));
  world.lines.length = 0;
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^failed: bnkb$/m);
  assert.equal((await world.records("bnka-current")).length, 2);
});

test("a refused renewal that returns the stored session closes nothing, and sync still fetches through it", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  world.paste = (url) => world.bank.approve(url, { only: [IBAN, JOINT] });
  assert.equal(await world.run("auth", "bnka"), 0);
  const state = await world.state("bnka");

  // The closed account is opened again, and the bank hands back the consent it holds, which
  // does not cover it. Nothing new was given, so there is nothing to close.
  const config = worldConfig();
  config.accounts["bnka-old"] = { bank: "bnka", iban: "NL00BNKA0000000003" };
  await writeFile(world.env.CONFIG_PATH, JSON.stringify(config));
  world.at("2026-03-02T03:00:00Z");
  world.paste = (url) => world.bank.approve(url, { same: true });
  world.lines.length = 0;
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /^bnka-old: the consent does not cover it$/m);
  assert.equal(deletes(world).length, 0);
  assert.ok(!printed(world).includes("consent just given"));
  assert.deepEqual(await world.state("bnka"), state);

  world.at("2026-03-03T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-02"));
  world.lines.length = 0;
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^failed: bnka-old, bnkb$/m);
  assert.deepEqual(
    (await world.records("bnka-current")).map((record) => record.id),
    ["a", "b"],
  );
});

test("a renewal after the previous session expired closes nothing", async (t) => {
  const world = await start(t);
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal((await world.state("bnka"))?.valid_until, "2026-08-28T03:00:00Z");
  world.at("2026-09-01T03:00:00Z");
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(deletes(world).length, 0);
  assert.ok(!printed(world).includes("previous-closed"));
});

test("a close the bank refuses is a note, and the renewal still succeeds", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);

  world.at("2026-03-02T03:00:00Z");
  // A renewal asks for the bank list, the authorisation and the session, then one page for
  // each of the two accounts, and closes last: the sixth request.
  world.bank.requests.length = 0;
  world.bank.failRequest(6, { status: 404, error: "SESSION_DOES_NOT_EXIST" });
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(world.bank.requests.length, 6);
  assert.equal(world.bank.requests[5].method, "DELETE");
  assert.match(
    printed(world),
    /^The previous consent was not closed, and ends by itself on 2026-08-28: Enable Banking answered 404 SESSION_DOES_NOT_EXIST\.$/m,
  );
  assert.ok(!printed(world).includes("previous-closed"));

  world.at("2026-03-03T03:00:00Z");
  world.add(IBAN, booked("b", "2026-03-02"));
  // The other bank was never authorised, which is the only reason this run fails.
  world.lines.length = 0;
  assert.equal(await world.run("sync"), 1);
  assert.match(printed(world), /^failed: bnkb$/m);
  assert.equal((await world.records("bnka-current")).length, 2);
});

test("a renewal whose fetch fails still closes the previous session", async (t) => {
  const world = await start(t);
  world.add(IBAN, booked("a", "2026-02-20"));
  assert.equal(await world.run("auth", "bnka"), 0);
  const old = (await world.state("bnka"))?.session_id;

  world.at("2026-03-02T03:00:00Z");
  // The bank list, the authorisation, the session, then the first account's page.
  world.bank.failRequest(4, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /^The consent is stored\. Not fetched in full: /m);
  assert.deepEqual(deletes(world), [`/sessions/${old}`]);
  assert.match(printed(world), /^previous-closed bank=bnka$/m);
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
    /^The consent is stored\. Not fetched in full: bnka-current\. Run auth bnka again now: only then can the bank be asked for the whole history\. Until then the nightly sync stores only what the bank serves unattended, and fails\.$/m,
  );
});

test("after a first fetch that failed, sync stores what the bank serves unattended and fails, until auth is run again", async (t) => {
  const world = await start(t);
  // Older than the 90 days the fake bank serves without the user.
  world.add(IBAN, booked("old", "2025-06-01"));
  world.add(IBAN, booked("recent", "2026-02-20"));
  // Requests: the bank list, the authorisation, the session, then the first account's
  // first page.
  world.bank.failRequest(4, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("auth", "bnka"), 1);

  const line =
    "bnka-current: fetched without a first success, so the bank gave only what it serves unattended. Run: auth bnka";
  const archives: Map<string, string>[] = [];
  for (const night of ["2026-03-02T03:00:00Z", "2026-03-03T03:00:00Z"]) {
    world.at(night);
    world.lines.length = 0;
    assert.equal(await world.run("sync"), 1);
    assert.ok(world.lines.includes(line), night);
    assert.deepEqual(
      (await world.records("bnka-current")).map((record) => record.id),
      ["recent"],
    );
    assert.equal((await world.state("bnka"))?.accounts["bnka-current"].last_success, undefined);
    archives.push(await world.files());
  }
  assert.deepEqual(archives[1], archives[0]);

  world.at("2026-03-04T03:00:00Z");
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.deepEqual((await world.records("bnka-current")).map((record) => record.id).toSorted(), [
    "old",
    "recent",
  ]);
  assert.equal(
    (await world.state("bnka"))?.accounts["bnka-current"].last_success,
    "2026-03-04T03:00:00Z",
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

test("a consent that covers two accounts under one IBAN stores nothing and guesses nothing", async (t) => {
  const aspsps = worldAspsps();
  aspsps[0].accounts.push({ iban: IBAN, transactions: [] });
  const world = await start(t, { aspsps });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(
    printed(world),
    /bnka-current: the consent covers more than one account with its iban/,
  );
  assert.equal(await world.state("bnka"), null);
  assert.equal(world.transactionRequests().length, 0);
});

test("input that ends at the prompt fails the run, stores nothing and frees the lock", async (t) => {
  const world = await start(t);
  world.paste = () => {
    throw new SyncError("no address was given");
  };
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(world.lines[world.lines.length - 1], "no address was given");
  assert.equal(await world.state("bnka"), null);
  assert.deepEqual(await readdir(world.stateDir), []);
});

test("an error nobody expected stops the run, prints only its class and code, and frees the lock", async (t) => {
  const world = await start(t);
  // A file where the account's inbox directory belongs, appearing while the user is at the
  // bank: after everything auth reads beforehand, and before the fetch.
  world.paste = (url) => {
    writeFileSync(join(world.dataDir, ".inbox", "bnka-current"), "Recognisable contents");
    return world.bank.approve(url);
  };
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(world.lines[world.lines.length - 1], "unexpected Error ENOTDIR");
  // The consent was stored before the fetch failed, and the user is told so.
  assert.ok((await world.state("bnka"))?.session_id);
  assert.match(
    world.lines[world.lines.length - 2],
    /^The consent is stored\. Not fetched in full: bnka-current, bnka-joint\. Run auth bnka again now: /,
  );
  assert.ok(!printed(world).includes(world.dataDir));
  assert.ok(!(await readdir(world.stateDir)).includes("lock"));
});

test("a data directory that cannot be written stops auth before any request", async (t) => {
  const world = await makeWorld();
  t.after(async () => {
    await chmod(world.dataDir, 0o755);
    await world.cleanup();
  });
  await chmod(world.dataDir, 0o555);
  // The precondition: this user is in fact refused. Without it the test proves nothing.
  await assert.rejects(writeFile(join(world.dataDir, "probe"), ""), { code: "EACCES" });

  assert.equal(await world.run("auth", "bnka"), 1);
  assert.equal(printed(world), "DATA_DIR cannot be written (EACCES)");
  assert.equal(world.bank.requests.length, 0);
  assert.equal(await world.state("bnka"), null);
  assert.deepEqual(await readdir(world.stateDir), []);
});

test("a year file that cannot be read stops auth before the user is sent to the bank", async (t) => {
  const world = await start(t);
  await mkdir(join(world.dataDir, "bnka-joint", "api"), { recursive: true });
  await writeFile(join(world.dataDir, "bnka-joint", "api", "2026.json"), "[ half a fi");
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /^bnka-joint: .*2026\.json/m);
  assert.equal(world.bank.requests.length, 0);
  assert.equal(await world.state("bnka"), null);
});

test("an inbox run that cannot be read stops auth before the user is sent to the bank", async (t) => {
  const world = await start(t);
  const run = join(world.dataDir, ".inbox", "bnka-joint", "20260228T030000Z");
  await mkdir(run, { recursive: true });
  await writeFile(join(run, "2.json"), '{"transactions":[]}');
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.match(printed(world), /^bnka-joint: bnka-joint, run 20260228T030000Z: page 1 is absent$/m);
  assert.equal(world.bank.requests.length, 0);
  assert.equal(await world.state("bnka"), null);
  // Reading ahead merges nothing and removes nothing.
  assert.deepEqual(await readdir(run), ["2.json"]);
});

test("reading ahead writes nothing: an inbox run is left for the fetch to merge", async (t) => {
  const world = await start(t);
  const run = join(world.dataDir, ".inbox", "bnka-current", "20260228T030000Z");
  await mkdir(run, { recursive: true });
  await writeFile(
    join(run, "1.json"),
    JSON.stringify({ transactions: [booked("left", "2026-02-20")] }),
  );
  // The command gets no further than the list of banks.
  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("auth", "bnka"), 1);
  assert.deepEqual(await readdir(run), ["1.json"]);
  assert.deepEqual(await readdir(world.dataDir), [".inbox"]);
});

test("an authorisation that takes longer than a token lasts still completes", async (t) => {
  const world = await start(t);
  for (const id of ["a", "b", "c"]) world.add(IBAN, booked(id, "2026-02-20"));
  world.bank.pageSize = 2;
  const later = (minutes: number): void => {
    world.time.now = new Date(world.time.now.getTime() + minutes * 60_000);
  };
  // The user spends more than an hour at the bank before pasting the address.
  world.paste = (url) => {
    later(61);
    return world.bank.approve(url);
  };
  // And more than an hour passes between the first page of the fetch and the second.
  const real = world.deps.fetch;
  let pages = 0;
  world.deps.fetch = async (url, init) => {
    const answer = await real(url, init);
    if (url.includes("/transactions")) {
      pages += 1;
      if (pages === 1) later(61);
    }
    return answer;
  };

  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(pages, 3);
  assert.deepEqual(
    (await world.records("bnka-current")).map((record) => record.id),
    ["a", "b", "c"],
  );
});
