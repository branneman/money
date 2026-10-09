import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Workspace = { dir: string; name: string; dependencies: Record<string, string> };

export const readWorkspaces = (root: string): Workspace[] => {
  const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  return (rootPackage.workspaces ?? []).map((dir) => {
    const manifest = JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as {
      name: string;
      dependencies?: Record<string, string>;
    };
    return { dir, name: manifest.name, dependencies: manifest.dependencies ?? {} };
  });
};

// A git worktree without its own install resolves workspace packages up into the main
// checkout. Nothing errors, and every check then judges the wrong source tree.
export const linkProblems = (
  root: string,
  workspaces: readonly Workspace[],
  resolve: (name: string) => string | null,
  realPath: (path: string) => string,
): string[] =>
  workspaces.flatMap(({ dir, name }) => {
    const expected = realPath(join(root, dir));
    const actual = resolve(name);
    if (actual === null) return [`${name} is not linked in this working tree. Run npm ci here.`];
    if (actual !== expected) {
      return [
        `${name} resolves to ${actual}, not to ${expected}. Run npm ci in this working tree.`,
      ];
    }
    return [];
  });

// Code that runs on the server, next to bank data. See docs/architecture.md, Dependencies.
const SERVER_WORKSPACES = ["shared", "sync", "api"];

export const dependencyProblems = (workspaces: readonly Workspace[]): string[] =>
  workspaces
    .filter((workspace) => SERVER_WORKSPACES.includes(workspace.dir))
    .flatMap((workspace) =>
      Object.keys(workspace.dependencies)
        .filter((dependency) => !dependency.startsWith("@money/"))
        .map(
          (dependency) =>
            `${workspace.name} depends on ${dependency}. Server workspaces may depend on other workspaces only.`,
        ),
    );
