import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { connect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";

import { SECURITY_HEADERS } from "./http/headers.ts";
import { makeLog } from "./log.ts";
import { makeServer } from "./serve.ts";

const start = async (
  handler: Parameters<typeof makeServer>[0],
): Promise<{ port: number; lines: string[]; server: Server; stop: () => Promise<void> }> => {
  const lines: string[] = [];
  const server = makeServer(
    handler,
    makeLog((line) => lines.push(line)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    lines,
    server,
    stop: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

const get = (port: number): Promise<{ status: number; headers: Record<string, unknown> }> =>
  new Promise((resolve, reject) => {
    httpRequest({ host: "127.0.0.1", port, path: "/", agent: false }, (response) => {
      response.resume();
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers }),
      );
    })
      .on("error", reject)
      .end();
  });

test("a handler that rejects is a logged 500 with the security headers, not an unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => void rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  const { port, lines, stop } = await start(() => Promise.reject(new RangeError("secret detail")));
  try {
    const answer = await get(port);
    assert.equal(answer.status, 500);
    assert.equal(
      answer.headers["content-security-policy"],
      SECURITY_HEADERS["Content-Security-Policy"],
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(rejections, []);
    assert.deepEqual(lines, ["failed RangeError"]);
  } finally {
    process.off("unhandledRejection", onRejection);
    await stop();
  }
});

// Sends bytes and collects what comes back until the connection ends.
const raw = (port: number, bytes: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => socket.write(bytes));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("close", () => resolve(Buffer.concat(chunks).toString()));
    setTimeout(() => reject(new Error("the connection was left open")), 3000).unref();
  });

const CSP = `Content-Security-Policy: ${SECURITY_HEADERS["Content-Security-Policy"]}`;

// Raises a client error of the given code on a real connection, as Node's parser would.
const raise = async (port: number, server: Server, code: string): Promise<string> => {
  const caught = new Promise<Socket>((resolve) => server.once("connection", resolve));
  const client = connect(port, "127.0.0.1");
  const chunks: Buffer[] = [];
  client.on("data", (chunk) => chunks.push(chunk));
  const ended = new Promise((resolve) => client.on("close", resolve));
  server.emit("clientError", Object.assign(new Error("x"), { code }), await caught);
  await ended;
  return Buffer.concat(chunks).toString();
};

test("headers over the limit are a 431 with the security headers and their own log line", async () => {
  const { port, lines, stop } = await start(() => Promise.resolve());
  try {
    const answer = await raw(port, `GET / HTTP/1.1\r\nX-Pad: ${"a".repeat(20 * 1024)}\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 431 /);
    assert.ok(answer.includes(CSP));
    assert.deepEqual(lines, ["headers too large"]);
  } finally {
    await stop();
  }
});

test("a request that took too long is a 408 with its own log line", async () => {
  const { port, lines, server, stop } = await start(() => Promise.resolve());
  try {
    const answer = await raise(port, server, "ERR_HTTP_REQUEST_TIMEOUT");
    assert.match(answer, /^HTTP\/1\.1 408 /);
    assert.ok(answer.includes(CSP));
    assert.deepEqual(lines, ["request timeout"]);
  } finally {
    await stop();
  }
});

test("a client's own reset is neither answered nor logged", async () => {
  const { port, lines, server, stop } = await start(() => Promise.resolve());
  try {
    assert.equal(await raise(port, server, "ECONNRESET"), "");
    assert.deepEqual(lines, []);
  } finally {
    await stop();
  }
});
