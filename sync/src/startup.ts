import { readFile, stat } from "node:fs/promises";

import { validateConfig } from "@money/shared";
import type { Config } from "@money/shared";

import { readSettings } from "./env.ts";
import type { Environment, Settings } from "./env.ts";
import { SyncError } from "./errors.ts";

const codeOf = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

// This user is refused, which in the image means a mount owned by someone else.
const isRefused = (error: unknown): boolean => ["EACCES", "EPERM"].includes(codeOf(error) ?? "");

type Directory = "yes" | "absent" | "unreachable";

const directoryAt = async (path: string): Promise<Directory> => {
  try {
    return (await stat(path)).isDirectory() ? "yes" : "absent";
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return "absent";
    if (isRefused(error)) return "unreachable";
    throw error;
  }
};

// The problem with a directory setting, or nothing when it names a directory.
const directoryProblem = async (name: string, path: string): Promise<string[]> => {
  const found = await directoryAt(path);
  if (found === "absent") return [`${name} does not name an existing directory`];
  if (found === "unreachable") return [`${name} cannot be reached by this user`];
  return [];
};

// The configuration, or null with its problems added to the list.
const readConfig = async (path: string, problems: string[]): Promise<Config | null> => {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRefused(error)) {
      problems.push("CONFIG_PATH names a file this user cannot read");
      return null;
    }
    // No such file, a directory in its place, or a file where one of its parents belongs.
    if (!["ENOENT", "EISDIR", "ENOTDIR"].includes(codeOf(error) ?? "")) throw error;
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
  problems.push(...(await directoryProblem("DATA_DIR", settings.dataDir)));
  problems.push(...(await directoryProblem("STATE_DIR", settings.stateDir)));
  const config = await readConfig(settings.configPath, problems);
  if (problems.length > 0 || config === null) throw new SyncError(problems.join("\n"));
  return { settings, config };
};
