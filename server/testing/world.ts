// A real server on a free port of 127.0.0.1, over temporary directories, for tests: the
// configuration, the archive, the session secret and the client's files are all written
// here, the clock is the test's, and every line the server prints is kept.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { Agent, request as httpRequest } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ArchiveRecord, Config, PersonEntry, Source } from "@money/shared";
import { renderYearFiles } from "@money/shared";
import { writeAtomic, writeYearFiles } from "@money/shared/node";
import { aConfig, anApiRecord, anImportRecord } from "@money/shared/testing";

import { hashPassword } from "../src/auth/password.ts";
import { makeHandler } from "../src/handler.ts";
import { makeLog } from "../src/log.ts";
import { rotateSecret } from "../src/secret.ts";
import { makeHandlerDeps, makeServer } from "../src/serve.ts";
import type { Settings } from "../src/settings.ts";

// Invented people, with the passwords they type. Nothing here is a real credential.
export const PEOPLE = {
  ana: { username: "tw-ana-Xr4k8Qm2", password: "world password ana" },
  ben: { username: "tw-ben-Lp7c3Vn9", password: "world password ben" },
} as const;

export const REVISION = "0123456789abcdef0123456789abcdef01234567";
export const START = "2026-11-02T09:00:00Z";

// Hashed with the real parameters, once per process, the first time a world wants them.
let hashedPeople: Promise<Record<string, PersonEntry>> | null = null;

const hashedPeopleOf = (): Promise<Record<string, PersonEntry>> => {
  hashedPeople ??= (async () => ({
    ana: {
      username: PEOPLE.ana.username,
      password: await hashPassword(PEOPLE.ana.password, Buffer.alloc(16, 1)),
    },
    ben: {
      username: PEOPLE.ben.username,
      password: await hashPassword(PEOPLE.ben.password, Buffer.alloc(16, 2)),
    },
  }))();
  return hashedPeople;
};

// ana owns bnka-solo alone, and bnka-shared with ben.
export const worldConfig = async (): Promise<Config> =>
  aConfig({
    accounts: {
      "bnka-solo": { bank: "bnka", iban: "NL00BNKA0000000001", owners: ["ana"] },
      "bnka-shared": { bank: "bnka", iban: "NL00BNKA0000000002", owners: ["ana", "ben"] },
    },
    people: await hashedPeopleOf(),
  });

// Three transactions in bnka-solo, two in bnka-shared.
export const worldRecords = (): ArchiveRecord[] => [
  anApiRecord({ account: "bnka-solo", id: "solo-1", date: "2026-10-01" }),
  anApiRecord({ account: "bnka-solo", id: "solo-2", date: "2026-10-02" }),
  anImportRecord({ account: "bnka-solo", id: "000000000000000001", date: "2026-09-30" }),
  anApiRecord({ account: "bnka-shared", id: "shared-1", date: "2026-10-01" }),
  anApiRecord({ account: "bnka-shared", id: "shared-2", date: "2026-10-03" }),
];

// Writes records into an archive through the real store, account and source at a time.
export const writeRecords = async (
  dataDir: string,
  records: readonly ArchiveRecord[],
): Promise<void> => {
  const groups = Map.groupBy(records, (record) => `${record.account}/${record.source}`);
  for (const items of groups.values()) {
    const { account, source } = items[0] as { account: string; source: Source };
    await writeYearFiles(dataDir, account, source, renderYearFiles(items));
  }
};

export type WorldResponse = { status: number; headers: IncomingHttpHeaders; body: string };

export type ServerWorld = {
  url: string;
  host: string;
  clock: { now(): Date; advance(ms: number): void };
  output: string[];
  configPath: string;
  dataDir: string;
  appDataDir: string;
  clientDir: string;
  writeConfig(config: Config): Promise<void>;
  rotateSecret(): Promise<void>;
  request(
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: string },
  ): Promise<WorldResponse>;
  // `cookie` is the name and value, ready for a Cookie header; null when none was set.
  login(username: string, password: string): Promise<{ status: number; cookie: string | null }>;
  session(cookie: string): Promise<{ person: string; accounts: string[]; csrf: string }>;
  close(): Promise<void>;
};

export const makeServerWorld = async (
  options: { config?: Config; records?: ArchiveRecord[] } = {},
): Promise<ServerWorld> => {
  const dir = await mkdtemp(join(tmpdir(), "money-server-"));
  const settings: Settings = {
    configPath: join(dir, "config.json"),
    dataDir: join(dir, "data"),
    appDataDir: join(dir, "app-data"),
    clientDir: join(dir, "client"),
    port: 0,
    revision: REVISION,
  };
  for (const path of [settings.dataDir, settings.appDataDir, settings.clientDir]) {
    await mkdir(path);
  }
  const writeConfig = (config: Config): Promise<void> =>
    writeAtomic(settings.configPath, JSON.stringify(config, null, 2), 0o644);
  await writeConfig(options.config ?? (await worldConfig()));
  await writeRecords(settings.dataDir, options.records ?? worldRecords());
  await rotateSecret(settings.appDataDir, randomBytes);

  let now = new Date(START).getTime();
  const clock = (): Date => new Date(now);
  const output: string[] = [];
  const log = makeLog((line) => output.push(line));
  const server = makeServer(makeHandler(makeHandlerDeps(settings, clock, log)), log);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const host = `127.0.0.1:${port}`;
  const url = `http://${host}`;

  // node:http, not fetch, so that Origin, Host and Sec-Fetch-Site are exactly what the
  // test says. A connection of its own each time, so nothing of one request reaches the
  // next; kept alive, as a browser's is, so that a Connection: close is the server's own.
  const request: ServerWorld["request"] = (method, path, { headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const agent = new Agent({ keepAlive: true });
      const sent = httpRequest(
        { host: "127.0.0.1", port, method, path, headers, agent },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            agent.destroy();
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
          response.on("error", reject);
        },
      );
      sent.on("error", reject);
      sent.end(body);
    });

  const login: ServerWorld["login"] = async (username, password) => {
    const response = await request("POST", "/api/login", {
      headers: { Origin: url, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const set = response.headers["set-cookie"] ?? [];
    return { status: response.status, cookie: set.length === 1 ? set[0].split(";")[0] : null };
  };

  const session: ServerWorld["session"] = async (cookie) => {
    const response = await request("GET", "/api/session", { headers: { Cookie: cookie } });
    if (response.status !== 200) throw new Error(`GET /api/session was ${response.status}`);
    return JSON.parse(response.body) as { person: string; accounts: string[]; csrf: string };
  };

  return {
    url,
    host,
    clock: {
      now: clock,
      advance: (ms) => {
        now += ms;
      },
    },
    output,
    configPath: settings.configPath,
    dataDir: settings.dataDir,
    appDataDir: settings.appDataDir,
    clientDir: settings.clientDir,
    writeConfig,
    rotateSecret: () => rotateSecret(settings.appDataDir, randomBytes),
    request,
    login,
    session,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    },
  };
};
