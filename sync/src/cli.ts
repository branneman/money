// The only place that touches the real world: the environment, the clock, the network,
// the terminal and the process table. Everything else receives them.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { describeError, SyncError } from "./errors.ts";
import { main } from "./main.ts";

// When the input ends before an answer (Ctrl-D, or no stdin), question() never settles and
// the process would exit 0 with the lock held, so the end of input is a failure.
const readLine = async (prompt: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const ended = new Promise<never>((_, reject) => {
    terminal.once("close", () => reject(new SyncError("no address was given")));
  });
  try {
    return await Promise.race([terminal.question(prompt), ended]);
  } finally {
    terminal.removeAllListeners("close");
    terminal.close();
  }
};

// Signal 0 tests for a process without touching it. EPERM means it exists and belongs to
// someone else.
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

main(process.argv.slice(2), process.env, {
  fetch,
  clock: () => new Date(),
  out: (line) => console.log(line),
  readLine,
  randomState: randomUUID,
  pid: process.pid,
  isAlive,
  checkpoint: () => undefined,
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Exit codes are the alerting interface, and job output leaves the host.
    console.error(describeError(error));
    process.exitCode = 1;
  },
);
