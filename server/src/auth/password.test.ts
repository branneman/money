import assert from "node:assert/strict";
import { randomBytes, scrypt } from "node:crypto";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  DUMMY_HASH,
  SCRYPT,
  formatHash,
  hashPassword,
  isStrongEnough,
  parseHash,
  verifyPassword,
} from "./password.ts";
import type { PasswordHash } from "./password.ts";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const sample: PasswordHash = {
  N: SCRYPT.N,
  r: SCRYPT.r,
  p: SCRYPT.p,
  salt: Buffer.alloc(SCRYPT.saltBytes, 1),
  key: Buffer.alloc(SCRYPT.keyBytes, 2),
};

const withParts = (replace: (parts: string[]) => string[]): string =>
  replace(formatHash(sample).split("$")).join("$");

test("a hash round-trips through its text", () => {
  const text = formatHash(sample);
  assert.match(text, /^scrypt\$N=131072,r=8,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
  assert.deepEqual(parseHash(text), sample);
});

test("parseHash refuses", async (t) => {
  const good = formatHash(sample);
  const cases: Record<string, string> = {
    "another algorithm name": good.replace("scrypt", "argon2"),
    "a missing part": withParts((p) => p.slice(0, 3)),
    "padding =": `${good}=`,
    "a non-number parameter": good.replace("N=131072", "N=lots"),
    "an extra $ part": `${good}$more`,
    "an empty salt": withParts((p) => [p[0], p[1], "", p[3]]),
  };
  for (const [name, text] of Object.entries(cases)) {
    await t.test(name, () => assert.equal(parseHash(text), null));
  }
});

test("isStrongEnough refuses N=65536, r=4, a 15-byte salt and a 31-byte key", () => {
  assert.equal(isStrongEnough(sample), true);
  assert.equal(isStrongEnough({ ...sample, N: 65536 }), false);
  assert.equal(isStrongEnough({ ...sample, r: 4 }), false);
  assert.equal(isStrongEnough({ ...sample, salt: Buffer.alloc(15) }), false);
  assert.equal(isStrongEnough({ ...sample, key: Buffer.alloc(31) }), false);
});

test("verifyPassword accepts the password and refuses one character changed", async () => {
  const text = await hashPassword("correct horse battery", randomBytes(SCRYPT.saltBytes));
  const hash = parseHash(text);
  assert.ok(hash);
  assert.equal(isStrongEnough(hash), true);
  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("correct horse batterz", hash), false);
});

test("verifyPassword uses the parameters stored in the hash", async () => {
  const salt = randomBytes(SCRYPT.saltBytes);
  const key = await scryptAsync("a weaker password", salt, SCRYPT.keyBytes, {
    N: 1024,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const hash: PasswordHash = { N: 1024, r: 8, p: 1, salt, key };
  assert.equal(await verifyPassword("a weaker password", hash), true);
  assert.equal(await verifyPassword("a weaker passworc", hash), false);
});

test("the dummy hash has the full parameters", () => {
  assert.equal(isStrongEnough(DUMMY_HASH), true);
  assert.equal(DUMMY_HASH.N, SCRYPT.N);
  assert.equal(DUMMY_HASH.r, SCRYPT.r);
  assert.equal(DUMMY_HASH.p, SCRYPT.p);
});
