import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { readJson } from "./body.ts";

const LIMIT = 4096;

type Outcome = Awaited<ReturnType<typeof readJson>>;

const withServer = async (
  run: (port: number, outcome: Promise<Outcome>) => Promise<void>,
): Promise<void> => {
  let resolveOutcome!: (value: Outcome) => void;
  const outcome = new Promise<Outcome>((resolve) => (resolveOutcome = resolve));
  const server: Server = createServer((req, res) => {
    void readJson(req, LIMIT).then((result) => {
      resolveOutcome(result);
      res.writeHead(result.ok ? 200 : result.status, { Connection: "close" }).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port, outcome);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
};

const send = (
  port: number,
  headers: Record<string, string>,
  chunks: readonly Buffer[],
): Promise<void> =>
  new Promise((resolve) => {
    const req = httpRequest({ port, host: "127.0.0.1", method: "POST", headers }, (res) => {
      res.resume();
      res.on("close", resolve);
    });
    // The server may answer and hang up before the body is all sent.
    req.on("error", () => resolve());
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });

const json = { "Content-Type": "application/json" };

test("valid JSON is parsed, and charset parameters are allowed", async () => {
  await withServer(async (port, outcome) => {
    await send(port, { "Content-Type": "application/json; charset=utf-8" }, [
      Buffer.from('{"a":1}'),
    ]);
    assert.deepEqual(await outcome, { ok: true, value: { a: 1 } });
  });
});

test("text/plain is 415", async () => {
  await withServer(async (port, outcome) => {
    await send(port, { "Content-Type": "text/plain" }, [Buffer.from("{}")]);
    assert.deepEqual(await outcome, { ok: false, status: 415 });
  });
});

test("a missing content type is 415", async () => {
  await withServer(async (port, outcome) => {
    await send(port, {}, [Buffer.from("{}")]);
    assert.deepEqual(await outcome, { ok: false, status: 415 });
  });
});

test("4097 bytes with a Content-Length is 413", async () => {
  await withServer(async (port, outcome) => {
    const body = Buffer.alloc(LIMIT + 1, 0x20);
    await send(port, { ...json, "Content-Length": String(body.length) }, [body]);
    assert.deepEqual(await outcome, { ok: false, status: 413 });
  });
});

test("5000 bytes chunked with no Content-Length is 413", async () => {
  await withServer(async (port, outcome) => {
    const chunks = Array.from({ length: 5 }, () => Buffer.alloc(1000, 0x20));
    await send(port, json, chunks);
    assert.deepEqual(await outcome, { ok: false, status: 413 });
  });
});

test("exactly the limit is accepted", async () => {
  await withServer(async (port, outcome) => {
    const body = Buffer.concat([Buffer.from("[]"), Buffer.alloc(LIMIT - 2, 0x20)]);
    await send(port, json, [body]);
    assert.deepEqual(await outcome, { ok: true, value: [] });
  });
});

test("invalid JSON is 400, and so is an empty body", async () => {
  await withServer(async (port, outcome) => {
    await send(port, json, [Buffer.from("{nope")]);
    assert.deepEqual(await outcome, { ok: false, status: 400 });
  });
  await withServer(async (port, outcome) => {
    await send(port, json, []);
    assert.deepEqual(await outcome, { ok: false, status: 400 });
  });
});
