// The only place that touches the real world: the environment, the clock, the network,
// the terminal and the process table. Everything else receives them.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";

import { describeError } from "./errors.ts";
import { main } from "./main.ts";

const readLine = async (prompt: string): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
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
