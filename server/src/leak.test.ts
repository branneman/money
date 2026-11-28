// Job output and the server's lines leave the production host, so nothing a person typed,
// nothing that identifies a person or a session, and nothing the archive holds may be printed.
// Each test drives a group of printing paths through the real server and the real `main`,
// and scans everything printed against one table of planted values. A scan of nothing would
// pass, so each test also checks that the line of every path it meant to reach is there.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { ArchiveRecord, Config } from "@money/shared";
import { writeAtomic } from "@money/shared/node";
import { aConfig, anApiRaw, anApiRecord, anImportRaw, anImportRecord } from "@money/shared/testing";

import { hashPassword, parseHash } from "./auth/password.ts";
import { main } from "./main.ts";
import type { Deps } from "./main.ts";
import { SECRET_FILE } from "./secret.ts";
import { makeServerWorld } from "../testing/world.ts";
import type { ServerWorld } from "../testing/world.ts";

type Planted = readonly [label: string, value: string];

// People are keyed by first names in production, so their keys are as private as the rest.
const ANA = { key: "zqana", username: "zq-user-ana-81", password: "zq-password-ana-4492" };
const BEN = { key: "zqben", username: "zq-user-ben-37", password: "zq-password-ben-5108" };
const WRONG_PASSWORD = "zq-wrong-7731";
const UNKNOWN_USERNAME = "zq-nobody-55";
const WRONG_CSRF = "zq-csrf-wrong-6620";
const SOLO = "bnka-zqsolo";
const SHARED = "bnka-zqshared";
const UNKNOWN_ACCOUNT = "bnka-zqmissing";
const SOLO_IBAN = "NL00ZQXA0246813579";
const SHARED_IBAN = "NL00ZQXB0135792468";
const COUNTERPARTY_IBAN = "NL00ZQXC0987654321";

const inGroups = (iban: string): string => (iban.match(/.{1,4}/g) ?? []).join(" ");

const ARCHIVE: Planted[] = [
  ["a transaction's identifier", "zq-ref"],
  ["an import row's sequence number", "770000000000000001"],
  ["a creditor's name", "Quillon Wrexford"],
  ["a debtor's name", "Marisol Thackeray"],
  ["an import row's counterparty", "Ottoline Faversham"],
  ["a remittance text", "Zebrafinch invoice 55120"],
  ["an import row's text", "Heliotrope refund 77031"],
  ["a bank transaction description", "Plantedtxdesc"],
  ["a bank transaction code", "XQZDEB"],
  ["an amount", "7391.28"],
  ["an amount, with a comma", "7391,28"],
  ["an amount, without a separator", "739128"],
  ["an import row's amount", "4826,95"],
  ["an import row's amount, with a point", "4826.95"],
  ...[SOLO_IBAN, SHARED_IBAN, COUNTERPARTY_IBAN].flatMap((iban): Planted[] => [
    ["an IBAN, compact", iban],
    ["an IBAN, in groups of four", inGroups(iban)],
  ]),
];

const PEOPLE: Planted[] = [
  ["a person's key", ANA.key],
  ["a person's key", BEN.key],
  ["a username", ANA.username],
  ["a username", BEN.username],
  ["a password", ANA.password],
  ["a password", BEN.password],
  ["a wrong password", WRONG_PASSWORD],
  ["a username nobody has", UNKNOWN_USERNAME],
  ["a CSRF token the test made up", WRONG_CSRF],
  ["an account key", SOLO],
  ["an account key", SHARED],
  ["an account key that does not exist", UNKNOWN_ACCOUNT],
];

const records = (): ArchiveRecord[] => [
  anApiRecord({
    account: SOLO,
    id: "zq-ref-1",
    date: "2026-10-01",
    raw: anApiRaw({
      entry_reference: "zq-ref-1",
      transaction_amount: { currency: "EUR", amount: "7391.28" },
      creditor: { name: "Quillon Wrexford" },
      creditor_account: { iban: COUNTERPARTY_IBAN },
      debtor: { name: "Marisol Thackeray" },
      debtor_account: { iban: SOLO_IBAN },
      remittance_information: ["Zebrafinch invoice 55120"],
      bank_transaction_code: { description: "Plantedtxdesc", code: "XQZDEB", sub_code: null },
    }),
  }),
  anImportRecord({
    account: SOLO,
    id: "770000000000000001",
    date: "2026-09-30",
    raw: anImportRaw({
      Account: SOLO_IBAN,
      Sequence: "770000000000000001",
      Amount: "-4826,95",
      "Counterparty account": COUNTERPARTY_IBAN,
      Counterparty: "Ottoline Faversham",
      "Text 1": "Heliotrope refund 77031",
    }),
  }),
  anApiRecord({
    account: SHARED,
    id: "zq-ref-2",
    date: "2026-10-03",
    raw: anApiRaw({
      entry_reference: "zq-ref-2",
      creditor_account: { iban: COUNTERPARTY_IBAN },
      debtor_account: { iban: SHARED_IBAN },
    }),
  }),
];

const plantedConfig = async (): Promise<Config> =>
  aConfig({
    accounts: {
      [SOLO]: { bank: "bnka", iban: SOLO_IBAN, owners: [ANA.key] },
      [SHARED]: { bank: "bnka", iban: SHARED_IBAN, owners: [ANA.key, BEN.key] },
    },
    people: {
      [ANA.key]: {
        username: ANA.username,
        password: await hashPassword(ANA.password, Buffer.alloc(16, 1)),
      },
      [BEN.key]: {
        username: BEN.username,
        password: await hashPassword(BEN.password, Buffer.alloc(16, 2)),
      },
    },
  });

// A configuration that cannot load, and holds a username and a person's key to be found.
const badConfigText = JSON.stringify({
  people: { [ANA.key]: { username: ANA.username, password: "zq-not-a-hash" } },
});

// The value of a cookie, whole and in its parts, and the token a session hands out: each
// identifies a session, so none may be printed.
const sessionSecrets = (cookie: string, csrf: string): Planted[] => {
  const value = cookie.slice(cookie.indexOf("=") + 1);
  return [
    ["a session cookie", cookie],
    ["a session cookie's value", value],
    ...value.split(".").map((part): Planted => ["a part of a session cookie's value", part]),
    ["a CSRF token", csrf],
  ];
};

const assertNothingPrinted = (printed: readonly string[], planted: readonly Planted[]): void => {
  const text = printed.join("\n").toLowerCase();
  for (const [label, value] of planted) {
    assert.notEqual(value, "", `the value of ${label} is empty, so the scan would match nothing`);
    assert.ok(!text.includes(value.toLowerCase()), `something printed holds ${label}`);
  }
};

// A request line is matched by its start, since the time taken follows it.
const assertPrinted = (printed: readonly string[], expected: readonly string[]): void => {
  for (const line of expected) {
    assert.ok(
      printed.some((item) => item === line || item.startsWith(`${line} `)),
      `no line "${line}" was printed, so that path was not reached`,
    );
  }
};

const post = (
  world: ServerWorld,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  world.request("POST", path, {
    headers: { Origin: world.url, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const attempt = (world: ServerWorld, username: string, password: string) =>
  post(world, "/api/login", { username, password });

const rawBytes = (host: string, bytes: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const [name, port] = host.split(":");
    const socket = connect(Number(port), name, () => socket.write(bytes));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => reject(new Error("the connection was left open")), 3000).unref();
  });

test("nothing a person typed, no session and nothing the archive holds is printed by the running server", async () => {
  const world = await makeServerWorld({ config: await plantedConfig(), records: records() });
  try {
    const secrets: Planted[] = [];
    const signIn = async (person: typeof ANA): Promise<string> => {
      const { status, cookie } = await world.login(person.username, person.password);
      assert.equal(status, 204);
      assert.ok(cookie !== null);
      const { csrf } = await world.session(cookie);
      secrets.push(...sessionSecrets(cookie, csrf));
      return cookie;
    };
    const ana = await signIn(ANA);
    const ben = await signIn(BEN);
    const withCookie = (cookie: string) => ({ headers: { Cookie: cookie } });
    const get = async (path: string, cookie: string): Promise<number> =>
      (await world.request("GET", path, withCookie(cookie))).status;

    // Logins that fail: a wrong password, a username nobody has, then the limit.
    assert.equal((await attempt(world, ANA.username, WRONG_PASSWORD)).status, 401);
    for (let index = 0; index < 5; index += 1) {
      assert.equal((await attempt(world, UNKNOWN_USERNAME, WRONG_PASSWORD)).status, 401);
    }
    assert.equal((await attempt(world, UNKNOWN_USERNAME, ANA.password)).status, 429);

    // A burst of unknown usernames, in waves, until the queue is full.
    const answered: number[] = [];
    while (!answered.includes(503) && answered.length < 60) {
      const wave = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          attempt(world, `zq-burst-${answered.length + index}`, WRONG_PASSWORD),
        ),
      );
      answered.push(...wave.map((response) => response.status));
    }
    assert.ok(answered.includes(503), `no 503 in ${answered.length} logins`);

    // Reading: the accounts, one of their own, another's, and one that is not there.
    assert.equal(await get("/api/accounts", ana), 200);
    assert.equal(await get(`/api/accounts/${SOLO}`, ana), 200);
    assert.equal(await get(`/api/accounts/${SOLO}`, ben), 404);
    assert.equal(await get(`/api/accounts/${UNKNOWN_ACCOUNT}`, ana), 404);

    // A cookie that was tampered with, and one that is nothing like a cookie.
    const [name, value] = ana.split("=");
    const tampered = `${name}=${value.slice(0, -2)}${value.endsWith("AA") ? "BB" : "AA"}`;
    secrets.push(["a tampered cookie", tampered]);
    assert.equal(await get("/api/session", tampered), 401);
    assert.equal(await get("/api/session", `${name}=${ANA.key}.zq`), 401);

    // Logout: refused for a wrong token, then done with the right one.
    const refused = await post(
      world,
      "/api/logout",
      {},
      { Cookie: ana, "X-CSRF-Token": WRONG_CSRF },
    );
    assert.equal(refused.status, 403);
    const { csrf } = await world.session(ben);
    const done = await post(world, "/api/logout", {}, { Cookie: ben, "X-CSRF-Token": csrf });
    assert.equal(done.status, 204);

    // A malformed request, answered by the clientError handler, with recognisable bytes.
    const answer = await rawBytes(
      world.host,
      `GET /zq-leaked-path HTTP/1.1\r\nZq Bad Header: ${ANA.password}\r\n\r\n`,
    );
    assert.match(answer, /^HTTP\/1\.1 400 /);

    // Files that go bad while the server runs: the configuration, then the secret.
    await writeFile(world.configPath, badConfigText);
    assert.equal((await world.request("GET", "/health")).status, 503);
    await world.writeConfig(await plantedConfig());
    await writeFile(join(world.appDataDir, SECRET_FILE), `${WRONG_PASSWORD}\n`);
    assert.equal((await world.request("GET", "/health")).status, 503);
    await world.rotateSecret();

    // A 500: a file where an account's directory belongs.
    const fresh = await signIn(ANA);
    await writeFile(join(world.dataDir, "zq-stray"), "");
    assert.equal(await get("/api/accounts", fresh), 500);

    assertPrinted(world.output, [
      "login ok",
      "login refused",
      "login limited",
      "login queue full",
      "malformed request refused",
      "configuration invalid, refusing requests",
      "session secret invalid, refusing requests",
      "failed ArchiveError",
      "request method=POST route=/api/login status=204",
      "request method=POST route=/api/login status=401",
      "request method=POST route=/api/login status=429",
      "request method=POST route=/api/login status=503",
      "request method=GET route=/api/session status=200",
      "request method=GET route=/api/session status=401",
      "request method=GET route=/api/accounts status=200",
      "request method=GET route=/api/accounts status=500",
      "request method=GET route=/api/accounts/:key status=200",
      "request method=GET route=/api/accounts/:key status=404",
      "request method=POST route=/api/logout status=403",
      "request method=POST route=/api/logout status=204",
      "request method=GET route=/health status=503",
    ]);
    assertNothingPrinted(world.output, [
      ...PEOPLE,
      ...ARCHIVE,
      ...secrets,
      ["the world's own data directory", world.dataDir],
      ["the path of a malformed request", "zq-leaked-path"],
      ["the header of a malformed request", "Zq Bad Header"],
    ]);
  } finally {
    await world.close();
  }
});

type Printed = { out: string[]; err: string[] };

const depsFor = (printed: Printed, answers: string[], isTerminal: boolean): Deps => ({
  clock: () => new Date("2026-11-02T09:00:00Z"),
  out: (line) => printed.out.push(line),
  err: (line) => printed.err.push(line),
  randomBytes,
  isTerminal,
  readHidden: () => {
    const answer = answers.shift();
    return answer === undefined
      ? Promise.reject(new Error("no more answers"))
      : Promise.resolve(answer);
  },
  listen: () => Promise.reject(new Error("a refused start must not listen")),
});

test("nothing a person typed or the environment holds is printed by the commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "money-leak-"));
  try {
    const env = {
      CONFIG_PATH: join(dir, "config.json"),
      DATA_DIR: join(dir, "data"),
      APP_DATA_DIR: join(dir, "app-data"),
      CLIENT_DIR: join(dir, "client"),
      PORT: "8080",
      REVISION: "rev1",
    };
    for (const path of [env.DATA_DIR, env.APP_DATA_DIR, env.CLIENT_DIR]) await mkdir(path);
    const refusals: Printed = { out: [], err: [] };
    const serve = (vars: Record<string, string>) =>
      main(["serve"], vars, depsFor(refusals, [], false));

    // Variables the server refuses to be given, and a configuration that cannot load.
    assert.deepEqual(await serve({ ...env, EB_PRIVATE_KEY: "zq-key-value" }), { exit: 1 });
    assert.deepEqual(await serve({ ...env, STATE_DIR: "zq-state-value" }), { exit: 1 });
    await writeAtomic(env.CONFIG_PATH, badConfigText, 0o644);
    assert.deepEqual(await serve(env), { exit: 1 });
    // A secret that is invalid, and a command nobody has.
    await writeFile(join(env.APP_DATA_DIR, SECRET_FILE), `${WRONG_PASSWORD}\n`);
    assert.deepEqual(await serve(env), { exit: 1 });
    assert.deepEqual(await main(["zq-command"], env, depsFor(refusals, [], false)), { exit: 1 });
    assertPrinted(refusals.out, [
      "the session secret is missing or invalid. Run: money rotate-session-secret",
      "usage: serve | hash-password | rotate-session-secret",
    ]);
    assert.ok(refusals.out.some((line) => line.includes("EB_PRIVATE_KEY")));
    assert.ok(refusals.out.some((line) => line.includes("STATE_DIR")));

    // hash-password: the hash alone on standard output, the password nowhere.
    const hashing: Printed = { out: [], err: [] };
    const password = "zq-password-hash-9021";
    assert.deepEqual(
      await main(["hash-password"], {}, depsFor(hashing, [password, password], true)),
      { exit: 0 },
    );
    assert.equal(hashing.out.length, 1);
    assert.ok(parseHash(hashing.out[0]) !== null);
    assert.deepEqual(hashing.err, []);
    // Refused, to standard error: a password too short, and two that differ.
    assert.deepEqual(await main(["hash-password"], {}, depsFor(hashing, ["zq-short"], false)), {
      exit: 1,
    });
    const typed = ["zq-mismatch-one-1", "zq-mismatch-two-2"];
    assert.deepEqual(await main(["hash-password"], {}, depsFor(hashing, [...typed], true)), {
      exit: 1,
    });
    assertPrinted(hashing.err, [
      "a password needs at least 12 characters",
      "the two passwords differ",
    ]);

    // rotate-session-secret: says so, and the secret it wrote is nowhere.
    const rotating: Printed = { out: [], err: [] };
    await rm(join(env.APP_DATA_DIR, SECRET_FILE));
    const rotated = depsFor(rotating, [], false);
    assert.deepEqual(
      await main(["rotate-session-secret"], { APP_DATA_DIR: env.APP_DATA_DIR }, rotated),
      { exit: 0 },
    );
    assertPrinted(rotating.out, ["session secret rotated"]);
    const secret = (await readFile(join(env.APP_DATA_DIR, SECRET_FILE), "utf8")).trim();

    assertNothingPrinted(
      [...[refusals, hashing, rotating].flatMap((printed) => [...printed.out, ...printed.err])],
      [
        ...PEOPLE,
        ["the key given in the environment", "zq-key-value"],
        ["the state directory given in the environment", "zq-state-value"],
        ["an invalid password hash", "zq-not-a-hash"],
        ["a command that was typed", "zq-command"],
        ["a secret that was invalid", WRONG_PASSWORD],
        ["a password given to hash-password", password],
        ["a password that was too short", "zq-short"],
        ["a password typed twice, first time", typed[0]],
        ["a password typed twice, second time", typed[1]],
        ["the session secret", secret],
        ["the test's own directory", dir],
      ],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
