import type { Config } from "@money/shared";

import type { Client, Fetch } from "./enablebanking/client.ts";
import type { Settings } from "./env.ts";
import type { Log } from "./log.ts";
import type { Clock } from "./time.ts";

// The points in a fetch between which a run can die. Production does nothing at them; a
// test stops a run there to prove the next one repairs it.
export type Checkpoint = "page-written" | "received" | "data-written" | "state-written";

// Everything a command touches outside its own arguments. cli.ts supplies the real ones.
export type Deps = {
  fetch: Fetch;
  clock: Clock;
  out: (line: string) => void;
  readLine: (prompt: string) => Promise<string>;
  randomState: () => string;
  pid: number;
  isAlive: (pid: number) => boolean;
  checkpoint: (point: Checkpoint) => void;
};

export type Context = {
  settings: Settings;
  config: Config;
  client: Client;
  deps: Deps;
  log: Log;
};
