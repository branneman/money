import { readFile, stat } from "node:fs/promises";

import { validateConfig } from "@money/shared";
import type { Config } from "@money/shared";

import { readSettings } from "./env.ts";
import type { Environment, Settings } from "./env.ts";
import { SyncError } from "./errors.ts";

const codeOf = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return false;
    throw error;
  }
};

// The configuration, or null with its problems added to the list.
const readConfig = async (path: string, problems: string[]): Promise<Config | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (codeOf(error) !== "ENOENT" && codeOf(error) !== "EISDIR") throw error;
    problems.push("CONFIG_PATH does not name a file");
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message quotes the file, which names real banks and accounts.
    problems.push("the configuration file is not valid JSON");
    return null;
  }
  const result = validateConfig(parsed);
  if (result.ok) return result.config;
  problems.push(...result.problems.map((problem) => `configuration: ${problem}`));
  return null;
};

// Everything a command needs before it does anything, or one error that lists every
// problem. A missing directory is an error and is never created: in production a missing
// mount would otherwise read as an empty archive.
export const loadStartup = async (
  env: Environment,
): Promise<{ settings: Settings; config: Config }> => {
  const result = readSettings(env);
  if (!result.ok) throw new SyncError(result.problems.join("\n"));
  const { settings } = result;

  const problems: string[] = [];
  if (!(await isDirectory(settings.dataDir))) {
    problems.push("DATA_DIR does not name an existing directory");
  }
  if (!(await isDirectory(settings.stateDir))) {
    problems.push("STATE_DIR does not name an existing directory");
  }
  const config = await readConfig(settings.configPath, problems);
  if (problems.length > 0 || config === null) throw new SyncError(problems.join("\n"));
  return { settings, config };
};
