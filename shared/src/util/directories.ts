import { stat } from "node:fs/promises";

export const codeOf = (error: unknown): string | undefined =>
  error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;

// This user is refused, which in the image means a mount owned by someone else.
export const isRefused = (error: unknown): boolean =>
  ["EACCES", "EPERM"].includes(codeOf(error) ?? "");

export type Directory = "yes" | "absent" | "unreachable";

export const directoryAt = async (path: string): Promise<Directory> => {
  try {
    return (await stat(path)).isDirectory() ? "yes" : "absent";
  } catch (error) {
    if (codeOf(error) === "ENOENT" || codeOf(error) === "ENOTDIR") return "absent";
    if (isRefused(error)) return "unreachable";
    throw error;
  }
};

// The problem with a directory setting, or nothing when it names a directory.
export const directoryProblem = async (name: string, path: string): Promise<string[]> => {
  const found = await directoryAt(path);
  if (found === "absent") return [`${name} does not name an existing directory`];
  if (found === "unreachable") return [`${name} cannot be reached by this user`];
  return [];
};
