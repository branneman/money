import { createSign } from "node:crypto";
import type { KeyObject } from "node:crypto";

// Enable Banking allows at most 24 hours. A token is minted for each request, so an hour is
// ample and a leaked one is soon worthless.
export const TOKEN_LIFETIME_SECONDS = 3600;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export const mintToken = (key: KeyObject, appId: string, now: Date): string => {
  const issued = Math.floor(now.getTime() / 1000);
  const head = encode({ typ: "JWT", alg: "RS256", kid: appId });
  const claims = encode({
    iss: "enablebanking.com",
    aud: "api.enablebanking.com",
    iat: issued,
    exp: issued + TOKEN_LIFETIME_SECONDS,
  });
  const signature = createSign("RSA-SHA256").update(`${head}.${claims}`).sign(key, "base64url");
  return `${head}.${claims}.${signature}`;
};
