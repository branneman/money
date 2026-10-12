// A whole sync on one machine, for tests: a temporary data and state directory, a fake
// bank, a clock the test moves, and everything that was printed.
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArchiveRecord, Config } from "@money/shared";
import { readAccountSource } from "@money/shared/node";
import { anApiRaw } from "@money/shared/testing";

import type { Checkpoint, Context, Deps } from "../src/context.ts";
import { makeClient } from "../src/enablebanking/client.ts";
import { readSettings } from "../src/env.ts";
import { listRuns } from "../src/inbox.ts";
import type { InboxRun } from "../src/inbox.ts";
import { mintToken } from "../src/jwt.ts";
import { makeLog } from "../src/log.ts";
import { readState, renewed, writeState } from "../src/state.ts";
import type { BankState } from "../src/state.ts";
import { timestampOf } from "../src/time.ts";
import { makeFakeBank } from "./fake-bank.ts";
import type { FakeAspsp, FakeBank, FakeVersion } from "./fake-bank.ts";

// One throwaway key pair for the whole test process. Never written anywhere.
export const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const APP_ID = "00000000-0000-4000-8000-00000000aaaa";
export const REDIRECT_URL = "https://localhost/auth-callback";

// What a test's checkpoint throws to stop a run where a real one would have died.
export class Crash extends Error {
  override name = "Crash";
}
export const CRASHED = -1;

const DAY = 86_400_000;

export const booked = (
  id: string,
  date: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> =>
  anApiRaw({ entry_reference: id, booking_date: date, value_date: date, ...overrides });

// Two banks, so nothing can assume there is one. The card has no IBAN and the old account
// is closed: neither is ever fetched.
export const worldConfig = (): Config => ({
  banks: {
    bnka: { aspsp: { name: "Example Bank", country: "NL" } },
    bnkb: { aspsp: { name: "Other Example Bank", country: "NL" } },
  },
  accounts: {
    "bnka-current": { bank: "bnka", iban: "NL00BNKA0000000001" },
    "bnka-joint": { bank: "bnka", iban: "NL00BNKA0000000002" },
    "bnka-card": { bank: "bnka", import_id: "1001" },
    "bnka-old": { bank: "bnka", iban: "NL00BNKA0000000003", closed: true },
    "bnkb-current": { bank: "bnkb", iban: "NL00BNKB0000000001" },
  },
  imports: {},
});

const aspsp = (name: string, ibans: string[]): FakeAspsp => ({
  name,
  country: "NL",
  maximumConsentValidity: 180 * 86_400,
  requiredPsuHeaders: [],
  unattendedDays: 90,
  ignoresStatusFilter: false,
  accounts: ibans.map((iban) => ({ iban, transactions: [] })),
});

export const worldAspsps = (): FakeAspsp[] => [
  aspsp("Example Bank", ["NL00BNKA0000000001", "NL00BNKA0000000002", "NL00BNKA0000000003"]),
  aspsp("Other Example Bank", ["NL00BNKB0000000001"]),
];

export type World = {
  dataDir: string;
  stateDir: string;
  env: Record<string, string>;
  config: Config;
  aspsps: FakeAspsp[];
  bank: FakeBank;
  time: { now: Date };
  lines: string[];
  alive: Set<number>;
  // The next time a run reaches this point, it dies there.
  crashAt: Checkpoint | null;
  // What the user pastes back, given the address that was printed.
  paste: (url: string) => string;
  deps: Deps;
  at: (timestamp: string) => void;
  // Gives an account a transaction, current from `from`. Returns its versions, so a test
  // can add a later one.
  add: (iban: string, raw: Record<string, unknown>, from?: string) => FakeVersion[];
  context: () => Context;
  // Authorises at the fake bank without the auth command, and stores the state.
  openSession: (bank: string) => Promise<Record<string, string>>;
  records: (account: string) => Promise<ArchiveRecord[]>;
  state: (bank: string) => Promise<BankState | null>;
  inbox: (account: string) => Promise<InboxRun[]>;
  // Every file of the archive, path to text, without the inbox.
  files: () => Promise<Map<string, string>>;
  transactionRequests: () => FakeBank["requests"];
  cleanup: () => Promise<void>;
};

export const makeWorld = async (
  options: {
    config?: Config;
    aspsps?: FakeAspsp[];
    start?: string;
    env?: Record<string, string>;
  } = {},
): Promise<World> => {
  const dir = await mkdtemp(join(tmpdir(), "money-sync-"));
  const dataDir = join(dir, "data");
  const stateDir = join(dir, "state");
  await mkdir(dataDir);
  await mkdir(stateDir);
  const config = options.config ?? worldConfig();
  await writeFile(join(dir, "config.json"), JSON.stringify(config));

  const time = { now: new Date(options.start ?? "2026-03-01T03:00:00Z") };
  const aspsps = options.aspsps ?? worldAspsps();
  const bank = makeFakeBank({
    clock: () => time.now,
    publicKey: KEYS.publicKey,
    appId: APP_ID,
    redirectUrl: REDIRECT_URL,
    aspsps,
  });
  const env = {
    EB_APP_ID: APP_ID,
    EB_PRIVATE_KEY: Buffer.from(KEYS.privateKey.export({ type: "pkcs8", format: "pem" })).toString(
      "base64",
    ),
    EB_REDIRECT_URL: REDIRECT_URL,
    CONFIG_PATH: join(dir, "config.json"),
    DATA_DIR: dataDir,
    STATE_DIR: stateDir,
    ...options.env,
  };

  const world: World = {
    dataDir,
    stateDir,
    env,
    config,
    aspsps,
    bank,
    time,
    lines: [],
    alive: new Set(),
    crashAt: null,
    paste: (url) => bank.approve(url),
    deps: {
      fetch: bank.fetch,
      clock: () => time.now,
      out: (line) => world.lines.push(line),
      readLine: () => {
        const url = world.lines.findLast((line) => line.startsWith("https://bank.example/"));
        if (url === undefined) return Promise.reject(new Error("no address was printed"));
        return Promise.resolve(world.paste(url));
      },
      randomState: () => "state-from-the-test",
      pid: 4242,
      isAlive: (pid) => world.alive.has(pid),
      checkpoint: (point) => {
        if (world.crashAt !== point) return;
        world.crashAt = null;
        throw new Crash(point);
      },
    },
    at: (timestamp) => {
      time.now = new Date(timestamp);
    },
    add: (iban, raw, from = "2000-01-01T00:00:00Z") => {
      const account = aspsps.flatMap((item) => item.accounts).find((item) => item.iban === iban);
      if (account === undefined) throw new Error("the fake bank has no such account");
      const versions: FakeVersion[] = [{ from, raw }];
      account.transactions.push(versions);
      return versions;
    },
    context: () => {
      const result = readSettings(env);
      if (!result.ok) throw new Error(result.problems.join("; "));
      const token = mintToken(KEYS.privateKey, APP_ID, time.now);
      return {
        settings: result.settings,
        config,
        client: makeClient(bank.fetch, token),
        deps: world.deps,
        log: makeLog(world.deps.out),
      };
    },
    openSession: async (bankKey) => {
      const { client } = world.context();
      const { url } = await client.startAuth({
        aspsp: config.banks[bankKey].aspsp,
        state: "state-from-the-test",
        redirectUrl: REDIRECT_URL,
        validUntil: timestampOf(new Date(time.now.getTime() + 180 * DAY)),
      });
      const code = new URL(bank.approve(url)).searchParams.get("code") ?? "";
      const session = await client.createSession(code);
      const uids: Record<string, string> = {};
      for (const [key, account] of Object.entries(config.accounts)) {
        if (account.bank !== bankKey || account.iban === undefined || account.closed === true) {
          continue;
        }
        const uid = session.accounts.find((item) => item.iban === account.iban)?.uid;
        if (uid === undefined || uid === null) throw new Error("the fake consent lacks an account");
        uids[key] = uid;
      }
      const previous = await readState(stateDir, bankKey);
      await writeState(stateDir, bankKey, renewed(previous, session, uids));
      return uids;
    },
    records: (account) => readAccountSource(dataDir, account, "api"),
    state: (bankKey) => readState(stateDir, bankKey),
    inbox: (account) => listRuns(dataDir, account),
    files: async () => {
      const found = new Map<string, string>();
      for (const entry of await readdir(dataDir, { recursive: true, withFileTypes: true })) {
        const path = join(entry.parentPath, entry.name);
        if (!entry.isFile() || path.includes(".inbox")) continue;
        found.set(path.slice(dataDir.length + 1), await readFile(path, "utf8"));
      }
      return new Map([...found].toSorted(([a], [b]) => (a < b ? -1 : 1)));
    },
    transactionRequests: () =>
      bank.requests.filter((request) => request.path.endsWith("/transactions")),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
  return world;
};
