import { createHmac, timingSafeEqual } from "node:crypto";

import type { Person } from "../people.ts";
import { formatHash } from "./password.ts";

export const SESSION_COOKIE = "__Host-session";
export const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// Milliseconds since the epoch.
export type Session = { person: string; issuedAt: number };

const hmac = (key: Buffer, text: string): Buffer => createHmac("sha256", key).update(text).digest();

// Derived from the username and the stored hash, so changing either ends that person's
// sessions, and rotating the secret ends everyone's.
export const signingKey = (secret: Buffer, person: Person): Buffer =>
  hmac(secret, `session\0${person.username}\0${formatHash(person.password)}`);

export const encodeSession = (session: Session, key: Buffer): string => {
  const payload = Buffer.from(JSON.stringify({ p: session.person, t: session.issuedAt })).toString(
    "base64url",
  );
  return `${payload}.${hmac(key, payload).toString("base64url")}`;
};

// Refuses anything but the unpadded base64url alphabet, and any text whose last character
// carries bits that decoding would silently drop.
const fromBase64url = (text: string): Buffer | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : null;
};

const sessionFromPayload = (payload: Buffer): { person: string; issuedAt: number } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    // Not JSON: a forged or damaged cookie, which is refused like any other.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "p" || keys[1] !== "t") return null;
  const { p, t } = parsed as { p: unknown; t: unknown };
  if (typeof p !== "string" || typeof t !== "number" || !Number.isSafeInteger(t)) return null;
  return { person: p, issuedAt: t };
};

export const decodeSession = (
  value: string,
  keyFor: (personKey: string) => Buffer | null,
  now: number,
): Session | null => {
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const payload = fromBase64url(parts[0]);
  const signature = fromBase64url(parts[1]);
  if (payload === null || signature === null) return null;
  const session = sessionFromPayload(payload);
  if (session === null) return null;
  const key = keyFor(session.person);
  if (key === null) return null;
  const expected = hmac(key, parts[0]);
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return null;
  if (session.issuedAt > now || now >= session.issuedAt + SESSION_MS) return null;
  return session;
};

// No Domain, so the browser returns it to the exact host only; __Host- makes it insist.
const ATTRIBUTES = "Path=/; Secure; HttpOnly; SameSite=Strict";

export const sessionCookie = (value: string): string =>
  `${SESSION_COOKIE}=${value}; Max-Age=${SESSION_MS / 1000}; ${ATTRIBUTES}`;

export const clearedCookie = (): string => `${SESSION_COOKIE}=; Max-Age=0; ${ATTRIBUTES}`;

// A second cookie of the same name is refused rather than picked from: which one a
// browser sent first is not something to trust.
export const cookieValue = (header: string | undefined): string | null => {
  if (header === undefined) return null;
  const prefix = `${SESSION_COOKIE}=`;
  const found = header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair.startsWith(prefix));
  return found.length === 1 ? found[0].slice(prefix.length) : null;
};

export const csrfToken = (cookie: string, key: Buffer): string =>
  hmac(key, `csrf\0${cookie}`).toString("base64url");

export const csrfMatches = (given: string | undefined, expected: string): boolean => {
  if (given === undefined) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
