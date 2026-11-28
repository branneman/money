import { access, constants } from "node:fs/promises";

import type { Environment } from "@money/shared";
import { directoryProblem, isRefused } from "@money/shared/node";

export type Settings = {
  configPath: string;
  dataDir: string;
  appDataDir: string;
  clientDir: string;
  port: number;
  revision: string;
};

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; problems: string[] };

// The server must never hold what reaches a bank. A web container handed the app's one
// shared environment file would carry the key, so its presence stops the server. The
// check is on the name alone: an empty EB_ variable is still the mistake.
const isBankCredential = (name: string): boolean => name.startsWith("EB_") || name === "STATE_DIR";

// Returns every problem at once. A message names a variable and never repeats its value.
export const readSettings = (env: Environment): SettingsResult => {
  const problems: string[] = [];
  const text = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      problems.push(`${name} is not set`);
      return "";
    }
    return value;
  };

  const configPath = text("CONFIG_PATH");
  const dataDir = text("DATA_DIR");
  const appDataDir = text("APP_DATA_DIR");
  const clientDir = text("CLIENT_DIR");
  const portText = text("PORT");
  const revision = text("REVISION");

  const port = Number(portText);
  if (portText !== "" && !(/^\d+$/.test(portText) && port >= 1 && port <= 65535)) {
    problems.push("PORT must be a port number");
  }
  for (const name of Object.keys(env).filter(isBankCredential)) {
    problems.push(`${name} must not reach the server`);
  }

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    settings: { configPath, dataDir, appDataDir, clientDir, port, revision },
  };
};

const writableDirectoryProblem = async (name: string, path: string): Promise<string[]> => {
  const problems = await directoryProblem(name, path);
  if (problems.length > 0) return problems;
  try {
    await access(path, constants.W_OK);
    return [];
  } catch (error) {
    if (isRefused(error)) return [`${name} cannot be written by this user`];
    throw error;
  }
};

// Nothing is created: in production a missing mount would otherwise read as an empty archive.
export const directoryProblems = async (settings: Settings): Promise<string[]> => [
  ...(await directoryProblem("DATA_DIR", settings.dataDir)),
  ...(await writableDirectoryProblem("APP_DATA_DIR", settings.appDataDir)),
  ...(await directoryProblem("CLIENT_DIR", settings.clientDir)),
];
