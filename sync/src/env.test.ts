import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

import { readSettings } from "./env.ts";

// A throwaway key, made here and never written anywhere.
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const KEY = Buffer.from(pem).toString("base64");

const env = (overrides: Record<string, string | undefined> = {}) => ({
  EB_APP_ID: "00000000-0000-4000-8000-00000000aaaa",
  EB_PRIVATE_KEY: KEY,
  EB_REDIRECT_URL: "https://localhost/auth-callback",
  CONFIG_PATH: "/somewhere/config.json",
  DATA_DIR: "/somewhere/data",
  STATE_DIR: "/somewhere/state",
  ...overrides,
});

const problemsOf = (overrides: Record<string, string | undefined>): string[] => {
  const result = readSettings(env(overrides));
  assert.equal(result.ok, false);
  return result.ok ? [] : result.problems;
};

test("a complete environment gives settings, with the defaults filled in", () => {
  const result = readSettings(env());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.settings.appId, "00000000-0000-4000-8000-00000000aaaa");
  assert.equal(result.settings.privateKey.asymmetricKeyType, "rsa");
  assert.equal(result.settings.redirectUrl, "https://localhost/auth-callback");
  assert.equal(result.settings.lookbackDays, 30);
  assert.equal(result.settings.consentWarnDays, 14);
});

test("the two numbers can be set, zero included", () => {
  const result = readSettings(env({ LOOKBACK_DAYS: "0", CONSENT_WARN_DAYS: "21" }));
  assert.equal(result.ok && result.settings.lookbackDays, 0);
  assert.equal(result.ok && result.settings.consentWarnDays, 21);
});

for (const name of [
  "EB_APP_ID",
  "EB_PRIVATE_KEY",
  "EB_REDIRECT_URL",
  "CONFIG_PATH",
  "DATA_DIR",
  "STATE_DIR",
]) {
  test(`${name} must be set`, () => {
    assert.deepEqual(problemsOf({ [name]: undefined }), [`${name} is not set`]);
    assert.deepEqual(problemsOf({ [name]: "" }), [`${name} is not set`]);
  });
}

test("a key that is not a base64-encoded PEM private key is refused", () => {
  const expected = ["EB_PRIVATE_KEY is not a base64-encoded PEM private key"];
  assert.deepEqual(problemsOf({ EB_PRIVATE_KEY: "not base64 at all !!" }), expected);
  assert.deepEqual(
    problemsOf({ EB_PRIVATE_KEY: Buffer.from("hello").toString("base64") }),
    expected,
  );
  // The PEM itself, not encoded: what someone pastes by mistake.
  assert.deepEqual(problemsOf({ EB_PRIVATE_KEY: String(pem) }), expected);
});

test("a key that is not an RSA key is refused", () => {
  const other = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" });
  assert.deepEqual(problemsOf({ EB_PRIVATE_KEY: Buffer.from(other).toString("base64") }), [
    "EB_PRIVATE_KEY is not an RSA key",
  ]);
});

test("the redirect address must be HTTPS", () => {
  const expected = ["EB_REDIRECT_URL must be an https address"];
  assert.deepEqual(problemsOf({ EB_REDIRECT_URL: "http://localhost/auth-callback" }), expected);
  assert.deepEqual(problemsOf({ EB_REDIRECT_URL: "localhost" }), expected);
});

test("the two numbers must be whole and not negative", () => {
  for (const value of ["-1", "1.5", "thirty", " 3"]) {
    assert.deepEqual(problemsOf({ LOOKBACK_DAYS: value }), [
      "LOOKBACK_DAYS must be a whole number, 0 or more",
    ]);
    assert.deepEqual(problemsOf({ CONSENT_WARN_DAYS: value }), [
      "CONSENT_WARN_DAYS must be a whole number, 0 or more",
    ]);
  }
});

test("every problem is reported together, and none repeats a value", () => {
  const problems = problemsOf({
    EB_APP_ID: undefined,
    EB_REDIRECT_URL: "http://recognisable.example/",
    LOOKBACK_DAYS: "recognisable",
  });
  assert.equal(problems.length, 3);
  assert.ok(!problems.join("\n").includes("recognisable"));
});
