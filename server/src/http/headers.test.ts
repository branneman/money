import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_STORE, SECURITY_HEADERS } from "./headers.ts";

test("the security headers are exactly the spec's table", () => {
  assert.deepEqual(SECURITY_HEADERS, {
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "accelerometer=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), hid=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(), screen-wake-lock=(), serial=(), usb=()",
    "X-Frame-Options": "DENY",
  });
});

test("the headers cannot be changed at run time", () => {
  assert.ok(Object.isFrozen(SECURITY_HEADERS));
  assert.ok(Object.isFrozen(NO_STORE));
});

test("API responses are never stored", () => {
  assert.deepEqual(NO_STORE, { "Cache-Control": "no-store" });
});
