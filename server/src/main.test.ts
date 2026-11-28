import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { writeAtomic } from "@money/shared/node";
import { aConfig } from "@money/shared/testing";

import { worldConfig } from "../testing/world.ts";
import { parseHash, verifyPassword } from "./auth/password.ts";
import { SECURITY_HEADERS } from "./http/headers.ts";
import { main } from "./main.ts";
import type { Deps } from "./main.ts";
import { SECRET_FILE, parseSecret } from "./secret.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

type Run = {
  lines: string[];
  errors: string[];
  asked: string[];
  closers: Array<() => Promise<void>>;
};

const newRun = (): Run => ({ lines: [], errors: [], asked: [], closers: [] });

// Real listening on a free port of 127.0.0.1; every other dependency a small fake.
const depsFor = (run: Run, options: { isTerminal?: boolean; answers?: string[] } = {}): Deps => {
  const answers = [...(options.answers ?? [])];
  return {
    clock: () => new Date("2026-11-02T09:00:00Z"),
    out: (line) => run.lines.push(line),
    err: (line) => run.errors.push(line),
    randomBytes,
    isTerminal: options.isTerminal ?? false,
    readHidden: (prompt) => {
      run.asked.push(prompt);
      const answer = answers.shift();
      if (answer === undefined) return Promise.reject(new Error("no more answers"));
      return Promise.resolve(answer);
    },
    listen: (server) =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const close = async (): Promise<void> => {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
          };
          run.closers.push(close);
          resolve({ port: (server.address() as AddressInfo).port, close });
        });
      }),
  };
};

const stopAll = async (run: Run): Promise<void> => {
  for (const close of run.closers) await close();
};

type Layout = { env: Record<string, string>; dir: string };

const layout = async (options: { secret?: boolean; config?: boolean } = {}): Promise<Layout> => {
  const dir = await mkdtemp(join(tmpdir(), "money-main-"));
  roots.push(dir);
  const env = {
    CONFIG_PATH: join(dir, "config.json"),
    DATA_DIR: join(dir, "data"),
    APP_DATA_DIR: join(dir, "app-data"),
    CLIENT_DIR: join(dir, "client"),
    PORT: "8080",
    REVISION: "rev1",
  };
  for (const path of [env.DATA_DIR, env.APP_DATA_DIR, env.CLIENT_DIR]) await mkdir(path);
  if (options.config !== false) {
    await writeAtomic(env.CONFIG_PATH, JSON.stringify(await worldConfig()), 0o644);
  }
  if (options.secret !== false) {
    const secret = randomBytes(32).toString("base64") + "\n";
    await writeAtomic(join(env.APP_DATA_DIR, SECRET_FILE), secret, 0o600);
  }
  return { env, dir };
};

for (const name of ["CONFIG_PATH", "DATA_DIR", "APP_DATA_DIR", "CLIENT_DIR", "PORT", "REVISION"]) {
  test(`serve without ${name} says so and exits 1`, async () => {
    const { env } = await layout();
    const run = newRun();
    const rest = Object.fromEntries(Object.entries(env).filter(([key]) => key !== name));
    assert.deepEqual(await main(["serve"], rest, depsFor(run)), { exit: 1 });
    assert.ok(run.lines.includes(`${name} is not set`), run.lines.join("\n"));
  });
}

for (const name of ["EB_PRIVATE_KEY", "STATE_DIR"]) {
  test(`serve refuses ${name} and does not print its value`, async () => {
    const { env } = await layout();
    const run = newRun();
    const value = "do-not-print-this-value";
    assert.deepEqual(await main(["serve"], { ...env, [name]: value }, depsFor(run)), { exit: 1 });
    assert.ok(run.lines.some((line) => line.includes(name)));
    assert.ok(!run.lines.join("\n").includes(value));
  });
}

const NO_SECRET = "the session secret is missing or invalid. Run: money rotate-session-secret";

test("serve without a secret names the command that makes one", async () => {
  const { env } = await layout({ secret: false });
  const run = newRun();
  assert.deepEqual(await main(["serve"], env, depsFor(run)), { exit: 1 });
  assert.deepEqual(run.lines, [NO_SECRET]);
});

test("serve with an invalid secret names the command too", async () => {
  const { env } = await layout();
  await writeFile(join(env.APP_DATA_DIR, SECRET_FILE), "short\n");
  const run = newRun();
  assert.deepEqual(await main(["serve"], env, depsFor(run)), { exit: 1 });
  assert.deepEqual(run.lines, [NO_SECRET]);
});

test("serve with a sync-only configuration prints the server's problems", async () => {
  const { env } = await layout();
  await writeAtomic(env.CONFIG_PATH, JSON.stringify(aConfig()), 0o644);
  const run = newRun();
  assert.deepEqual(await main(["serve"], env, depsFor(run)), { exit: 1 });
  assert.ok(run.lines.length > 0);
});

test("serve with a missing configuration file says so", async () => {
  const { env } = await layout({ config: false });
  const run = newRun();
  assert.deepEqual(await main(["serve"], env, depsFor(run)), { exit: 1 });
  assert.deepEqual(run.lines, ["CONFIG_PATH does not name a file"]);
});

test("serve with a missing directory prints the directory problem", async () => {
  const { env, dir } = await layout();
  const run = newRun();
  const result = await main(["serve"], { ...env, DATA_DIR: join(dir, "nope") }, depsFor(run));
  assert.deepEqual(result, { exit: 1 });
  assert.ok(run.lines.some((line) => line.includes("DATA_DIR")));
});

const get = (port: number, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
      );
    })
      .on("error", reject)
      .end();
  });

test("serve with everything valid runs and answers /health", async () => {
  const { env } = await layout();
  const run = newRun();
  try {
    const result = await main(["serve"], env, depsFor(run));
    assert.ok("running" in result);
    const health = await get(result.running.port, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { status: "ok" });
    assert.ok(
      run.lines.includes(`serving port=${result.running.port} revision=rev1 people=2 accounts=2`),
      run.lines.join("\n"),
    );
  } finally {
    await stopAll(run);
  }
});

// Sends bytes and collects what comes back until the server closes the connection.
const raw = (port: number, bytes: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(bytes));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => reject(new Error("the connection was left open")), 3000).unref();
  });

test("a malformed request is a 400 with the CSP, and is not logged", async () => {
  const { env } = await layout();
  const run = newRun();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => void rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const result = await main(["serve"], env, depsFor(run));
    assert.ok("running" in result);
    const answer = await raw(result.running.port, "GET / HTTP/1.1\r\nBad Header\r\n\r\n");
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.ok(
      answer.includes(`Content-Security-Policy: ${SECURITY_HEADERS["Content-Security-Policy"]}`),
    );
    // Still serving afterwards.
    assert.equal((await get(result.running.port, "/health")).status, 200);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
    assert.ok(!run.lines.join("\n").includes("Bad Header"));
  } finally {
    process.off("unhandledRejection", onRejection);
    await stopAll(run);
  }
});

test("hash-password on a terminal asks twice and prints a hash that verifies", async () => {
  const run = newRun();
  const password = "a long enough password";
  const result = await main(
    ["hash-password"],
    {},
    depsFor(run, { isTerminal: true, answers: [password, password] }),
  );
  assert.deepEqual(result, { exit: 0 });
  assert.deepEqual(run.asked, ["password: ", "again: "]);
  // Standard output holds the hash and nothing else, so a capture of it is usable.
  assert.equal(run.lines.length, 1);
  assert.deepEqual(run.errors, []);
  const hash = parseHash(run.lines[0]);
  assert.ok(hash !== null);
  assert.ok(await verifyPassword(password, hash));
  assert.ok(!(await verifyPassword("another password!", hash)));
});

test("hash-password refuses two passwords that differ", async () => {
  const run = newRun();
  const result = await main(
    ["hash-password"],
    {},
    depsFor(run, {
      isTerminal: true,
      answers: ["a long enough password", "a long enough passwore"],
    }),
  );
  assert.deepEqual(result, { exit: 1 });
  assert.deepEqual(run.errors, ["the two passwords differ"]);
  assert.deepEqual(run.lines, []);
});

test("hash-password refuses a password under 12 characters", async () => {
  const run = newRun();
  const result = await main(
    ["hash-password"],
    {},
    depsFor(run, { isTerminal: true, answers: ["short", "short"] }),
  );
  assert.deepEqual(result, { exit: 1 });
  assert.deepEqual(run.errors, ["a password needs at least 12 characters"]);
  assert.deepEqual(run.lines, []);
});

test("hash-password reads one line without a terminal", async () => {
  const run = newRun();
  const result = await main(
    ["hash-password"],
    {},
    depsFor(run, { isTerminal: false, answers: ["piped password one"] }),
  );
  assert.deepEqual(result, { exit: 0 });
  assert.equal(run.asked.length, 1);
  assert.ok(parseHash(run.lines[0]) !== null);
});

test("hash-password without a terminal still refuses a short password", async () => {
  const run = newRun();
  const result = await main(["hash-password"], {}, depsFor(run, { answers: ["short"] }));
  assert.deepEqual(result, { exit: 1 });
  assert.deepEqual(run.errors, ["a password needs at least 12 characters"]);
  assert.deepEqual(run.lines, []);
});

test("rotate-session-secret without APP_DATA_DIR says so", async () => {
  const run = newRun();
  assert.deepEqual(await main(["rotate-session-secret"], {}, depsFor(run)), { exit: 1 });
  assert.deepEqual(run.lines, ["APP_DATA_DIR is not set"]);
});

test("rotate-session-secret with a missing directory says so", async () => {
  const { dir } = await layout();
  const run = newRun();
  const result = await main(
    ["rotate-session-secret"],
    { APP_DATA_DIR: join(dir, "nope") },
    depsFor(run),
  );
  assert.deepEqual(result, { exit: 1 });
  assert.ok(run.lines.some((line) => line.includes("APP_DATA_DIR")));
});

test("rotate-session-secret writes a secret that parses, owner-only, and says so", async () => {
  const { env } = await layout({ secret: false });
  const run = newRun();
  const result = await main(
    ["rotate-session-secret"],
    { APP_DATA_DIR: env.APP_DATA_DIR },
    depsFor(run),
  );
  assert.deepEqual(result, { exit: 0 });
  assert.deepEqual(run.lines, ["session secret rotated"]);
  const path = join(env.APP_DATA_DIR, SECRET_FILE);
  assert.ok(parseSecret(await readFile(path, "utf8")) !== null);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("an unknown command, or none, prints the usage and exits 1", async () => {
  for (const argv of [["frobnicate"], [], ["serve", "extra"]]) {
    const run = newRun();
    assert.deepEqual(await main(argv, {}, depsFor(run)), { exit: 1 });
    assert.deepEqual(run.lines, ["usage: serve | hash-password | rotate-session-secret"]);
  }
});
