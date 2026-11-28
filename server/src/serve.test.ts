import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { SECURITY_HEADERS } from "./http/headers.ts";
import { makeLog } from "./log.ts";
import { makeServer } from "./serve.ts";

const start = async (
  handler: Parameters<typeof makeServer>[0],
): Promise<{ port: number; lines: string[]; stop: () => Promise<void> }> => {
  const lines: string[] = [];
  const server = makeServer(
    handler,
    makeLog((line) => lines.push(line)),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    lines,
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
