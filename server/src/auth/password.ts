import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const SCRYPT = {
  N: 131072,
  r: 8,
  p: 1,
  saltBytes: 16,
  keyBytes: 32,
} as const;

export const MIN_PASSWORD_LENGTH = 12;

// scrypt at N = 2^17, r = 8 needs 128 MiB; Node's default limit is 32 MiB.
const MAX_MEMORY = 256 * 1024 * 1024;

export type PasswordHash = {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
};

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// Standard base64 alphabet, padding removed.
const encode = (bytes: Buffer): string => bytes.toString("base64").replace(/=+$/, "");

const BASE64 = /^[A-Za-z0-9+/]+$/;
const PARAMETERS = /^N=(\d+),r=(\d+),p=(\d+)$/;

export const parseHash = (text: string): PasswordHash | null => {
  const parts = text.split("$");
  if (parts.length !== 4) return null;
  const [algorithm, parameters, salt, key] = parts;
  if (algorithm !== "scrypt") return null;
  const match = PARAMETERS.exec(parameters);
  if (match === null || !BASE64.test(salt) || !BASE64.test(key)) return null;
  return {
    N: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    salt: Buffer.from(salt, "base64"),
    key: Buffer.from(key, "base64"),
  };
};

export const formatHash = (hash: PasswordHash): string =>
  `scrypt$N=${hash.N},r=${hash.r},p=${hash.p}$${encode(hash.salt)}$${encode(hash.key)}`;

// Upper bounds, so a hand-edited hash is refused at startup instead of throwing or
// exhausting memory at login.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_BYTES = 64;

const isPowerOfTwo = (n: number): boolean => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0;

export const isStrongEnough = (hash: PasswordHash): boolean =>
  hash.N >= SCRYPT.N &&
  hash.r >= SCRYPT.r &&
  hash.p >= SCRYPT.p &&
  hash.salt.length === SCRYPT.saltBytes &&
  hash.key.length === SCRYPT.keyBytes &&
  isPowerOfTwo(hash.N) &&
  hash.N <= MAX_N &&
  hash.r <= MAX_R &&
  hash.p <= MAX_P &&
  hash.salt.length <= MAX_BYTES &&
  hash.key.length <= MAX_BYTES;

export const hashPassword = async (password: string, salt: Buffer): Promise<string> => {
  const key = await derive(password, salt, SCRYPT.keyBytes, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: MAX_MEMORY,
  });
  return formatHash({ N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt, key });
};

export const verifyPassword = async (password: string, hash: PasswordHash): Promise<boolean> => {
  const key = await derive(password, hash.salt, hash.key.length, {
    N: hash.N,
    r: hash.r,
    p: hash.p,
    maxmem: MAX_MEMORY,
  });
  return timingSafeEqual(key, hash.key);
};

// A fixed literal, never computed at load: that would cost a quarter second at every start.
// Checked against when a username is unknown, so that takes as long as a wrong password.
const DUMMY_HASH_TEXT =
  "scrypt$N=131072,r=8,p=1$BwcHBwcHBwcHBwcHBwcHBw$CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk";

const parsedDummy = parseHash(DUMMY_HASH_TEXT);
if (parsedDummy === null) throw new Error("DUMMY_HASH is not in the hash format");

export const DUMMY_HASH: PasswordHash = parsedDummy;
