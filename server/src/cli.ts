// The only place the server's commands touch the real world: the environment, the clock,
// randomness, the terminal and the network. Everything else receives them.
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

import { splitInput } from "./line-input.ts";
import { main } from "./main.ts";
import type { Running } from "./main.ts";

const NO_PASSWORD = "no password was given";

// One line from a pipe. The end of input before a line is a failure, not a silent hang.
// Prompts are not written here: with a pipe there is nobody to prompt.
const readLine = (): Promise<string> =>
  new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin });
    let given = false;
    lines.once("line", (line) => {
      // Closing emits "close", which must not be taken for the end of input.
      given = true;
      resolve(line);
      lines.close();
    });
    lines.once("close", () => {
      if (given) return;
      process.stderr.write(`${NO_PASSWORD}\n`);
      reject(new Error(NO_PASSWORD));
    });
  });

// Input that arrived after a line break in the same chunk, kept for the next read: a paste
// of "password\npassword\n" answers both questions.
let pending = "";
// A carriage return ended the last line at the end of a chunk: a line feed first in the
// next chunk is the same break, not an empty line.
let skipLineFeed = false;

// Typed characters are not echoed, and the prompt and newline go to stderr so that
// standard output stays the hash alone. Raw mode hands over every key, so Ctrl-C and
// Ctrl-D are handled in splitInput. If the terminal goes away the read fails, and the
// terminal's mode is put back either way.
const readHiddenOnTerminal = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const input = process.stdin;
    process.stderr.write(prompt);
    const finish = (): void => {
      input.off("data", onData);
      input.off("end", onGone);
      input.off("close", onGone);
      input.off("error", onGone);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
    };
    const abandon = (): void => {
      finish();
      pending = "";
      process.stderr.write(`${NO_PASSWORD}\n`);
      reject(new Error(NO_PASSWORD));
    };
    const take = (chunk: string): void => {
      const split = splitInput(pending, chunk, skipLineFeed);
      pending = split.rest;
      skipLineFeed = split.skipLineFeed;
      if (split.aborted) abandon();
      else if (split.line !== null) {
        finish();
        resolve(split.line);
      }
    };
    // Decoded as a stream, so a character split across two chunks is not broken.
    const onData = (chunk: string): void => take(chunk);
    const onGone = (): void => abandon();
    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    input.on("end", onGone);
    input.on("close", onGone);
    input.on("error", onGone);
    // A line left over from the last chunk may already be complete.
    take("");
  });

const isTerminal = process.stdin.isTTY;

main(process.argv.slice(2), process.env, {
  clock: () => new Date(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
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
