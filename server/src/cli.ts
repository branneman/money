// The only place the server's commands touch the real world: the environment, the clock,
// randomness, the terminal and the network. Everything else receives them.
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { main } from "./main.ts";
import type { Running } from "./main.ts";

// One line from a pipe. The end of input before a line is a failure, not a silent hang.
const readLine = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    lines.once("line", (line) => {
      // Settled before closing: closing emits "close", which would otherwise reject.
      resolve(line);
      lines.close();
    });
    lines.once("close", () => reject(new Error("no password was given")));
  });

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";

// Typed characters are not echoed. Raw mode hands over every key, so Ctrl-C and Ctrl-D
// are handled here.
const readHiddenOnTerminal = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stdout.write(prompt);
    let typed = "";
    const finish = (): void => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer): void => {
      for (const key of chunk.toString("utf8")) {
        if (key === "\r" || key === "\n") {
          finish();
          resolve(typed);
          return;
        }
        if (key === CTRL_C || key === CTRL_D) {
          finish();
          reject(new Error("no password was given"));
          return;
        }
        typed = key === BACKSPACE ? typed.slice(0, -1) : typed + key;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });

const isTerminal = process.stdin.isTTY;

main(process.argv.slice(2), process.env, {
  clock: () => new Date(),
  out: (line) => console.log(line),
  randomBytes,
  isTerminal,
  readHidden: isTerminal ? readHiddenOnTerminal : readLine,
  listen: (server, port) =>
    new Promise<Running>((resolve, reject) => {
      server.once("error", reject);
      // Every interface: in a container the proxy reaches it from outside.
      server.listen(port, () => {
        server.off("error", reject);
        resolve({
          port,
          close: async () => {
            server.closeAllConnections();
            await new Promise((done) => server.close(done));
          },
        });
      });
    }),
}).then(
  (outcome) => {
    // A running server is left to run: its listening socket keeps the process alive.
    if ("exit" in outcome) process.exitCode = outcome.exit;
  },
  (error: unknown) => {
    // Exit codes are the alerting interface, and job output leaves the host: the class
    // only, never a message that might quote a path or what was typed.
    console.error(`failed ${error instanceof Error ? error.constructor.name : typeof error}`);
    process.exitCode = 1;
  },
);
