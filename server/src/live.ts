import { readFile, stat } from "node:fs/promises";

// A value read from a file that may be replaced while the server runs. null means the file
// is missing, unreadable or does not parse right now: callers fail closed.
export type Live<T> = { current(): Promise<T | null> };

const MISSING = "missing";

const isCode = (error: unknown, ...codes: string[]): boolean =>
  error instanceof Error && "code" in error && codes.includes(String(error.code));

// Any other failure is a fault in the server or its volume, not a bad file, so it propagates.
const tolerated = async <R>(read: () => Promise<R>): Promise<R | null> => {
  try {
    return await read();
  } catch (error) {
    if (isCode(error, "ENOENT", "EACCES")) return null;
    throw error;
  }
};

// Looks at the file's identity on every call and reads it again only when that changed.
// The identity is taken before the read, so a file replaced in between is read again next
// time. onInvalid is called once per change of identity, not once per call, so a bad file
// is one log line and not one per request.
export const makeLive = <T>(
  path: string,
  parse: (text: string) => T | null,
  onInvalid: () => void,
): Live<T> => {
  let lastIdentity: string | null = null;
  let lastValue: T | null = null;
  // Permissions can be fixed without touching ino, mtime or size, so an unreadable file is
  // tried again on every call, and reported only once.
  let lastUnreadable = false;

  const current = async (): Promise<T | null> => {
    const info = await tolerated(() => stat(path));
    const identity = info === null ? MISSING : `${info.ino}:${info.mtimeMs}:${info.size}`;
    if (identity === lastIdentity && !lastUnreadable) return lastValue;

    const text = info === null ? null : await tolerated(() => readFile(path, "utf8"));
    const value = text === null ? null : parse(text);
    const changed = identity !== lastIdentity;
    lastIdentity = identity;
    lastValue = value;
    lastUnreadable = info !== null && text === null;
    if (value === null && changed) onInvalid();
    return value;
  };

  return { current };
};
