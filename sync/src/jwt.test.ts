import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { mintToken, TOKEN_LIFETIME_SECONDS } from "./jwt.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const NOW = new Date("2026-10-11T03:00:00.750Z");
const token = mintToken(privateKey, "00000000-0000-4000-8000-00000000aaaa", NOW);
const [head, claims, signature] = token.split(".");
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString());

test("a token has three parts and no padding", () => {
  assert.equal(token.split(".").length, 3);
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test("the header names the algorithm and carries the application id as kid", () => {
  assert.deepEqual(decode(head), {
    typ: "JWT",
    alg: "RS256",
    kid: "00000000-0000-4000-8000-00000000aaaa",
  });
});

test("the claims are the ones Enable Banking requires, in whole seconds", () => {
  const issued = Math.floor(NOW.getTime() / 1000);
  assert.deepEqual(decode(claims), {
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: issued,
    exp: issued + 3600,
  });
  assert.ok(TOKEN_LIFETIME_SECONDS <= 86_400, "the lifetime may not exceed 24 hours");
});

test("the signature verifies against the public half of the key", () => {
  const verified = createVerify("RSA-SHA256")
    .update(`${head}.${claims}`)
    .verify(publicKey, signature, "base64url");
  assert.equal(verified, true);
});
