// What `serve` and the tests' world both build the server from, so the two cannot drift.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { makeLimiter } from "./auth/limiter.ts";
import { makeQueue, QUEUE_LIMIT } from "./auth/queue.ts";
import { watchFiles } from "./handler.ts";
import type { HandlerDeps } from "./handler.ts";
import { SECURITY_HEADERS } from "./http/headers.ts";
import type { Log } from "./log.ts";
import type { Settings } from "./settings.ts";

export const makeHandlerDeps = (settings: Settings, clock: () => Date, log: Log): HandlerDeps => ({
  settings,
  clock,
  log,
  ...watchFiles(settings, log),
  limiter: makeLimiter(clock),
  queue: makeQueue(QUEUE_LIMIT),
});

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

const errorClass = (error: unknown): string =>
  error instanceof Error ? error.constructor.name : typeof error;

// The handler answers its own errors; this is the net under it, so that nothing it throws
// can become an unhandled rejection, and a connection is never left waiting.
const failed = (log: Log, response: ServerResponse, error: unknown): void => {
  log.event(`failed ${errorClass(error)}`);
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response
    .writeHead(500, { ...SECURITY_HEADERS, "Content-Length": "0", Connection: "close" })
    .end();
};

// A request Node's parser refused never reaches the handler, so it would carry no headers
// of its own. Answered with the security headers and a closed connection, and logged
// without anything of what was sent.
const refuse = (log: Log, socket: Duplex): void => {
  log.event("malformed request refused");
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const headers = Object.entries({
    ...SECURITY_HEADERS,
    "Content-Length": "0",
    Connection: "close",
  })
    .map(([name, value]) => `${name}: ${value}\r\n`)
    .join("");
  socket.end(`HTTP/1.1 400 Bad Request\r\n${headers}\r\n`);
};

export const makeServer = (handler: Handler, log: Log): Server => {
  const server = createServer((request, response) => {
    handler(request, response).catch((error: unknown) => failed(log, response, error));
  });
  server.on("clientError", (_error, socket) => refuse(log, socket));
  return server;
};
