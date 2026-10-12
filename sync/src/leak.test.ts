// Job output leaves the production host on every run, so nothing a bank sent, nothing that
// identifies a session or an account, and no credential may ever be printed. Each test drives
// a group of printing paths through the real commands and scans everything they printed
// against one table of planted values.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isObject, isText } from "@money/shared";

import { describeError } from "./errors.ts";
import { main } from "./main.ts";
import { APP_ID, booked, KEYS, makeWorld, REDIRECT_URL, worldAspsps } from "../testing/world.ts";
import type { World } from "../testing/world.ts";

const A = "NL00BNKA0000000001";
const B = "NL00BNKB0000000001";

type Planted = readonly [label: string, value: string];

// The amounts, in every way a line could write them. The integer parts have four digits and
// the cents end in a digit that is not 0, so no short form collapses to a plain integer, and
// the cents form has six digits. None of these can be a count, a date (always with dashes) or
// an account key, which is all the commands may print.
const amountForms = (units: string, cents: string): string[] => {
  const grouped = (separator: string): string => `${units[0]}${separator}${units.slice(1)}`;
  return [
    `${units}.${cents}`,
    `${units},${cents}`,
    `${grouped(".")},${cents}`,
    `${grouped(",")}.${cents}`,
    `${units}${cents}`,
    `${units}.${cents[0]}`,
    `${units},${cents[0]}`,
  ];
};

const inGroups = (iban: string): string => (iban.match(/.{1,4}/g) ?? []).join(" ");
const ibanForms = (label: string, iban: string): Planted[] => [
  [`${label}, compact`, iban],
  [`${label}, in groups of four`, inGroups(iban)],
];

const DEBIT = {
  amount: "7391.28",
  creditor: "Quillon Wrexford",
  creditorIban: "NL00ZQXA0246813579",
  debtor: "Marisol Thackeray",
  debtorIban: "NL00ZQXB0135792468",
  text: "Zebrafinch invoice 55120",
  code: "XQZDEB",
  description: "Plantedtxdesc",
};
const CREDIT = {
  amount: "4826.95",
  creditor: "Ottoline Faversham",
  creditorIban: "NL00ZQXC0987654321",
  debtor: "Barnaby Pettigrew",
  debtorIban: "NL00ZQXD0864209753",
  text: "Heliotrope refund 77031",
  code: "XQZCRD",
  description: "Plantedcreditdesc",
};

const fromTransaction = (kind: string, item: typeof DEBIT): Planted[] => [
  ...amountForms(...(item.amount.split(".") as [string, string])).map((form): Planted => [
    `the ${kind} amount`,
    form,
  ]),
  [`the ${kind}'s creditor name`, item.creditor],
  [`the ${kind}'s debtor name`, item.debtor],
  ...ibanForms(`the ${kind}'s creditor account`, item.creditorIban),
  ...ibanForms(`the ${kind}'s debtor account`, item.debtorIban),
  [`the ${kind}'s remittance text`, item.text],
  [`the ${kind}'s bank transaction code`, item.code],
  [`the ${kind}'s bank transaction description`, item.description],
];

const PLANTED_CODE = "planted-code-7f3a9c1e";
const PLANTED_TWICE = "twice-held-4c81d0e2";

const PLANTED: Planted[] = [
  ...fromTransaction("debit", DEBIT),
  ...fromTransaction("credit", CREDIT),
  // Every identifier planted below starts with this, so one entry covers them all.
  ["a transaction's identifier", "ref-secret"],
  ["the identifier of a transaction a page held twice", PLANTED_TWICE],
  ["text from a bank's reply", "Recognisable"],
  ["an IBAN", "NL00"],
  ["the one-time code in a pasted address", PLANTED_CODE],
  ["the state the test used", "state-from-the-test"],
];

const transaction = (id: string, date: string, item: typeof DEBIT, kind: "DBIT" | "CRDT") =>
  booked(id, date, {
    transaction_amount: { currency: "EUR", amount: item.amount },
    credit_debit_indicator: kind,
    creditor: { name: item.creditor },
    creditor_account: { iban: item.creditorIban },
    debtor: { name: item.debtor },
    debtor_account: { iban: item.debtorIban },
    remittance_information: [item.text],
    bank_transaction_code: { description: item.description, code: item.code, sub_code: null },
  });
const debit = (id: string, date: string) => transaction(id, date, DEBIT, "DBIT");
const credit = (id: string, date: string) => transaction(id, date, CREDIT, "CRDT");

const credentials = (world: World): Planted[] => {
  const pem = KEYS.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return [
    ["the private key, as the environment holds it", world.env.EB_PRIVATE_KEY],
    ...pem
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-----"))
      .map((line): Planted => ["a line of the private key's PEM body", line]),
    ["the private key's PEM header", "BEGIN PRIVATE KEY"],
    ["the application id", APP_ID],
    ["a signed token", "eyJ"],
  ];
};

const asText = (value: unknown): string => (isText(value) ? value : "");

// Watches the world: reads the session ids and account uids out of what the bank answers,
// including for a consent the sync refused and stored nothing for, and returns the scan.
const watch = (world: World): ((extra?: Planted[]) => Promise<void>) => {
  const seen: Planted[] = [];
  const real = world.deps.fetch;
  world.deps.fetch = async (url, init) => {
    const answer = await real(url, init);
    if (init.method === "POST" && url.endsWith("/sessions")) {
      const body: unknown = JSON.parse(await answer.text());
      if (isObject(body)) {
        seen.push(["a session id", asText(body.session_id)]);
        const accounts: unknown[] = Array.isArray(body.accounts) ? body.accounts : [];
        for (const account of accounts) {
          if (isObject(account)) seen.push(["an account uid", asText(account.uid)]);
        }
      }
    }
    return answer;
  };

  return async (extra = []) => {
    const stored: Planted[] = [];
    for (const bank of ["bnka", "bnkb"]) {
      const state = await world.state(bank);
      if (state === null) continue;
      stored.push(["a stored session id", state.session_id]);
      for (const account of Object.values(state.accounts)) {
        stored.push(["a stored account uid", account.uid]);
      }
    }
    const printed = world.lines.join("\n").toLowerCase();
    const forbidden = [
      ...PLANTED,
      ...credentials(world),
      ["the world's own data directory", world.dataDir],
      ...seen,
      ...stored,
      ...extra,
    ];
    for (const [label, value] of forbidden) {
      assert.notEqual(value, "", `the value of ${label} is empty, so the scan would match nothing`);
      assert.ok(!printed.includes(value.toLowerCase()), `something printed holds ${label}`);
    }
  };
};

// A command run with an environment of the test's own, as cli.ts would run it.
const runWith = async (
  world: World,
  env: Record<string, string | undefined>,
  ...argv: string[]
): Promise<number> => {
  try {
    return await main(argv, env, world.deps);
  } catch (error) {
    world.lines.push(describeError(error));
    return 1;
  }
};

test("nothing a bank sent, and nothing that identifies a session, is printed on a run that works or fails", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const scan = watch(world);
  world.add(A, debit("ref-secret-1", "2026-02-20"));
  const gone = world.add(A, credit("ref-secret-2", "2026-02-21"));
  world.add(B, credit("ref-secret-3", "2026-02-20"));

  // Everything going well.
  assert.equal(await world.run("auth", "bnka"), 0);
  assert.equal(await world.run("auth", "bnkb"), 0);
  assert.equal(await world.run("status"), 0);

  // A new transaction, and one the bank withdrew.
  world.at("2026-03-02T03:00:00Z");
  gone.push({ from: "2026-03-01T12:00:00Z", raw: null });
  world.add(A, debit("ref-secret-4", "2026-03-01"));
  assert.equal(await world.run("sync"), 1);

  // An error response, whose message and detail are recognisable.
  world.at("2026-03-03T03:00:00Z");
  world.bank.failRequest(1, { status: 500, error: "ASPSP_ERROR" });
  assert.equal(await world.run("sync"), 1);

  // An answer that is not JSON.
  world.at("2026-03-04T03:00:00Z");
  world.bank.failRequest(1, { body: "<html>Recognisable gateway page</html>" });
  assert.equal(await world.run("sync"), 1);

  // A booked transaction without its identifier, at the second bank.
  world.at("2026-03-05T03:00:00Z");
  world.add(B, debit("", "2026-03-04"));
  assert.equal(await world.run("sync"), 1);

  // A number that would not survive being stored, at the first bank.
  world.at("2026-03-06T03:00:00Z");
  const odd =
    '{"transactions":[{"status":"BOOK","entry_reference":"ref-secret-5",' +
    '"booking_date":"2026-03-05","note":"Recognisable note","rate":1.10}]}';
  world.bank.failRequest(1, { body: odd });
  assert.equal(await world.run("sync"), 1);

  // An error nobody expected: a file where an account's inbox directory belongs.
  world.at("2026-03-07T03:00:00Z");
  await rm(join(world.dataDir, ".inbox", "bnka-joint"), { recursive: true });
  await writeFile(join(world.dataDir, ".inbox", "bnka-joint"), "Recognisable contents");
  assert.equal(await world.run("sync"), 1);

  // The run did meet each of those outcomes.
  const printed = world.lines.join("\n");
  for (const outcome of [
    /authorised bank=bnka/,
    /were absent from a fetch that should hold them/,
    /Enable Banking answered 500 ASPSP_ERROR/,
    /page 1 is not valid JSON/,
    /is booked without an entry_reference/,
    /holds a number that would not survive being stored/,
    /unexpected Error ENOTDIR/,
  ]) {
    assert.match(printed, outcome);
  }
  await scan();
});

test("a page the merge refuses is reported by run and page, never by the transaction's identifier", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const scan = watch(world);
  await world.openSession("bnka");
  await world.openSession("bnkb");
  // One identifier, twice on one page, with different contents. It has come from a response
  // and is stored nowhere yet.
  world.add(A, debit(PLANTED_TWICE, "2026-02-20"));
  world.add(A, credit(PLANTED_TWICE, "2026-02-20"));
  assert.equal(await world.run("sync"), 1);

  // The run stays in the inbox, so the next night says it again.
  world.at("2026-03-02T03:00:00Z");
  assert.equal(await world.run("sync"), 1);

  const reports = world.lines.filter((line) =>
    /^bnka-current: bnka-current, run 20260301T030000Z, page 1 holds the same transaction twice with different contents$/.test(
      line,
    ),
  );
  assert.equal(reports.length, 2);
  assert.equal((await world.inbox("bnka-current")).length, 1);
  await scan();
});

test("a refused authorisation never prints what was pasted, nor what identifies an account", async (t) => {
  const aspsps = worldAspsps();
  aspsps[0].accounts.push({ iban: A, transactions: [] });
  const world = await makeWorld({ aspsps: aspsps.slice(0, 1) });
  t.after(world.cleanup);
  const scan = watch(world);
  const pastes: Planted[] = [];
  const pasting = (text: string): void => {
    world.paste = () => text;
    pastes.push(["a pasted address", text]);
  };

  // An address of this application, for another authorisation, carrying a one-time code.
  pasting(`${REDIRECT_URL}?state=another-state&code=${PLANTED_CODE}`);
  assert.equal(await world.run("auth", "bnka"), 1);

  // Not an address at all.
  pasting(`not an address ${PLANTED_CODE}`);
  assert.equal(await world.run("auth", "bnka"), 1);

  // An address, but of some other site.
  pasting(`https://elsewhere.example/auth-callback?state=state-from-the-test&code=${PLANTED_CODE}`);
  assert.equal(await world.run("auth", "bnka"), 1);

  // The bank refused, and said why in a way that is not ours to print.
  pasting(`${REDIRECT_URL}?error=access_denied&error_description=${PLANTED_CODE}`);
  assert.equal(await world.run("auth", "bnka"), 1);

  // A consent that holds two accounts with one iban. The bank still answered with ids.
  world.paste = (url) => world.bank.approve(url);
  assert.equal(await world.run("auth", "bnka"), 1);

  // A consent that leaves an account out.
  world.paste = (url) => world.bank.approve(url, { only: ["NL00BNKA0000000002"] });
  assert.equal(await world.run("auth", "bnka"), 1);

  const printed = world.lines.join("\n");
  for (const outcome of [
    /that address belongs to another authorisation/,
    /that is not an address/,
    /that is not the redirect address of this application/,
    /the bank did not grant the consent/,
    /bnka-current: the consent covers more than one account with its iban/,
    /bnka-current: the consent does not cover it/,
  ]) {
    assert.match(printed, outcome);
  }
  assert.equal(await world.state("bnka"), null);
  await scan([
    ["another authorisation's state", "another-state"],
    ["another site's host", "elsewhere.example"],
    ...pastes,
  ]);
});

test("status never prints a session or an account, however things stand", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const scan = watch(world);

  // A bank never authorised, next to one that was.
  await world.openSession("bnka");
  assert.equal(await world.run("status"), 1);

  // Both inside the warning window.
  await world.openSession("bnkb");
  world.at("2026-08-25T03:00:00Z");
  assert.equal(await world.run("status"), 1);

  // Both expired.
  world.at("2026-09-30T03:00:00Z");
  assert.equal(await world.run("status"), 1);

  const printed = world.lines.join("\n");
  for (const outcome of [/no consent is stored/, /days from now\. Run: auth/, /expired on/]) {
    assert.match(printed, outcome);
  }
  await scan();
});

test("sync never prints a session or an account when a consent is absent, near its end or over", async (t) => {
  // The banks reach back far enough for a run half a year after the last one to succeed.
  const aspsps = worldAspsps().map((aspsp) => ({ ...aspsp, unattendedDays: 400 }));
  const world = await makeWorld({ aspsps });
  t.after(world.cleanup);
  const scan = watch(world);
  world.add(A, debit("ref-secret-1", "2026-02-20"));
  world.add(A, credit("ref-secret-2", "2026-02-21"));

  // One bank without a consent.
  await world.openSession("bnka");
  assert.equal(await world.run("sync"), 1);

  // Near its end: the run goes on, and warns. The other bank has a consent by now, so a
  // clean exit shows the fetch itself worked.
  await world.openSession("bnkb");
  world.at("2026-08-25T03:00:00Z");
  assert.equal(await world.run("sync"), 0);

  // Over.
  world.at("2026-09-30T03:00:00Z");
  assert.equal(await world.run("sync"), 1);

  const printed = world.lines.join("\n");
  for (const outcome of [/bnkb: no consent is stored/, /consent-expiring/, /has expired/]) {
    assert.match(printed, outcome);
  }
  await scan();
});

test("a failed fetch never prints a request, a response or a header", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const scan = watch(world);
  world.add(A, debit("ref-secret-1", "2026-02-20"));
  world.add(A, credit("ref-secret-2", "2026-02-21"));
  await world.openSession("bnka");
  await world.openSession("bnkb");

  // The connection fails: the cause could carry the address, and the address holds a uid.
  world.at("2026-03-02T03:00:00Z");
  world.bank.failRequest(1, { network: true });
  assert.equal(await world.run("sync"), 1);

  // Refused for the token, the one place a header could be echoed.
  world.at("2026-03-03T03:00:00Z");
  world.bank.failRequest(1, { status: 401, error: "UNAUTHORIZED_ACCESS" });
  assert.equal(await world.run("sync"), 1);

  // Too many requests.
  world.at("2026-03-04T03:00:00Z");
  world.bank.failRequest(1, { status: 429, error: "ACCESS_EXCEEDED" });
  assert.equal(await world.run("sync"), 1);

  // An error code that is no code, next to a message and detail the bank wrote.
  world.at("2026-03-05T03:00:00Z");
  world.bank.failRequest(1, { status: 400, error: "not a code: Recognisable-odd" });
  assert.equal(await world.run("sync"), 1);

  // Scanned first: a line that leaks may be the very line the outcomes below look for.
  await scan([["an error code that is no code", "Recognisable-odd"]]);
  const printed = world.lines.join("\n");
  for (const outcome of [
    /no answer from Enable Banking \(/,
    /Enable Banking answered 401/,
    /Enable Banking answered 429/,
    /Enable Banking answered 400$/m,
  ]) {
    assert.match(printed, outcome);
  }
});

test("a start that is refused never prints a setting, a path or what a file held", async (t) => {
  const world = await makeWorld();
  t.after(world.cleanup);
  const scan = watch(world);
  const folder = await mkdtemp(join(tmpdir(), "money-leak-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const brokenConfig = join(folder, "broken-config.json");
  await writeFile(brokenConfig, `{"iban": "${DEBIT.creditorIban}", `);
  const missingConfig = join(folder, "planted-missing-config-5d1e.json");

  const appId = "planted-app-id-0b6c";
  const keyText = "planted-key-material-4d2b";
  const garbage = Buffer.from(keyText).toString("base64");
  const noBase64 = "planted key!! material-8a53";

  const refusals: [Record<string, string | undefined>, RegExp][] = [
    [{ ...world.env, EB_PRIVATE_KEY: undefined }, /EB_PRIVATE_KEY is not set/],
    [{ ...world.env, EB_PRIVATE_KEY: garbage }, /EB_PRIVATE_KEY is not a base64-encoded PEM/],
    [{ ...world.env, EB_PRIVATE_KEY: noBase64 }, /EB_PRIVATE_KEY is not a base64-encoded PEM/],
    [{ ...world.env, EB_APP_ID: undefined }, /EB_APP_ID is not set/],
    [{ ...world.env, EB_APP_ID: appId, EB_PRIVATE_KEY: garbage }, /EB_PRIVATE_KEY/],
    [{ ...world.env, CONFIG_PATH: missingConfig }, /CONFIG_PATH does not name a file/],
    [{ ...world.env, CONFIG_PATH: brokenConfig }, /the configuration file is not valid JSON/],
    [{ ...world.env, DATA_DIR: join(folder, "planted-no-data-dir") }, /DATA_DIR does not name/],
  ];
  for (const [env, outcome] of refusals) {
    const before = world.lines.length;
    assert.equal(await runWith(world, env, "status"), 1);
    assert.match(world.lines.slice(before).join("\n"), outcome);
  }
  const before = world.lines.length;
  assert.equal(await runWith(world, world.env, "sync", "extra"), 1);
  assert.match(world.lines.slice(before).join("\n"), /usage: auth <bank> \| sync \| status/);

  await scan([
    ["the app id given to a refused start", appId],
    ["the key material given to a refused start", keyText],
    ["the key given to a refused start, encoded", garbage],
    ["the key given to a refused start, not base64", noBase64],
    ["a path of a refused start", folder],
    ["the name of a configuration file", "planted-missing-config"],
    ["the name of a data directory", "planted-no-data-dir"],
  ]);
});
