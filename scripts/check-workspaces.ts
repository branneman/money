import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { linkProblems, readWorkspaces } from "./workspaces.ts";

const root = join(import.meta.dirname, "..");
const resolve = (name: string): string | null => {
  const path = join(root, "node_modules", name);
  return existsSync(path) ? realpathSync(path) : null;
};

const problems = linkProblems(root, readWorkspaces(root), resolve, realpathSync);
for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
