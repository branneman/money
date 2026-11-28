import { validateConfig } from "@money/shared";
import type { Config } from "@money/shared";

import { peopleOf, serverConfigProblems } from "./people.ts";
import type { Person } from "./people.ts";

export type ServerConfig = { config: Config; people: Person[] };

export type ServerConfigResult =
  { ok: true; value: ServerConfig } | { ok: false; problems: string[] };

// The problems never quote the text or the JSON parser's message: the message can quote
// the file, which holds password hashes and who owns what.
export const loadServerConfig = (text: string): ServerConfigResult => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["the configuration file is not valid JSON"] };
  }
  const checked = validateConfig(parsed);
  if (!checked.ok) return { ok: false, problems: checked.problems };
  const problems = serverConfigProblems(checked.config);
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { config: checked.config, people: peopleOf(checked.config) } };
};
