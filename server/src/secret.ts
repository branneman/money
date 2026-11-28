import { join } from "node:path";

import { writeAtomic } from "@money/shared/node";

export const SECRET_FILE = "session-secret";

const SECRET_BYTES = 32;

// 32 bytes are 44 characters of standard base64, the last of them padding.
const STANDARD_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

// Exactly one line, with or without its newline. Buffer.from is lenient about stray
// characters, so the shape is checked first.
export const parseSecret = (text: string): Buffer | null => {
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!STANDARD_BASE64.test(line)) return null;
  const bytes = Buffer.from(line, "base64");
  return bytes.length === SECRET_BYTES ? bytes : null;
};

// Replaces the secret by a rename, readable by its owner only. Every session signed under
// the old one stops being valid.
export const rotateSecret = async (
  appDataDir: string,
  randomBytes: (size: number) => Buffer,
): Promise<void> => {
  const text = randomBytes(SECRET_BYTES).toString("base64") + "\n";
  await writeAtomic(join(appDataDir, SECRET_FILE), text, 0o600);
};
