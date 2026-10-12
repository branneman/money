import { createPrivateKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

export type Environment = Readonly<Record<string, string | undefined>>;

export type Settings = {
  appId: string;
  privateKey: KeyObject;
  redirectUrl: string;
  configPath: string;
  dataDir: string;
  stateDir: string;
  lookbackDays: number;
  consentWarnDays: number;
};

export type SettingsResult = { ok: true; settings: Settings } | { ok: false; problems: string[] };

// The key travels as the PEM file base64-encoded, because the host delivers secrets as
// environment variables and a PEM has line breaks.
const readKey = (encoded: string, problems: string[]): KeyObject | null => {
  const refuse = (): null => {
    problems.push("EB_PRIVATE_KEY is not a base64-encoded PEM private key");
    return null;
  };
  if (!/^[A-Za-z0-9+/=\s]+$/.test(encoded)) return refuse();
  try {
    const key = createPrivateKey(Buffer.from(encoded, "base64").toString("utf8"));
    if (key.asymmetricKeyType !== "rsa") {
      problems.push("EB_PRIVATE_KEY is not an RSA key");
      return null;
    }
    return key;
  } catch {
    return refuse();
  }
};

// Returns every problem at once. A message names a variable and never repeats its value.
export const readSettings = (env: Environment): SettingsResult => {
  const problems: string[] = [];
  const text = (name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
      problems.push(`${name} is not set`);
      return "";
    }
    return value;
  };
  const wholeNumber = (name: string, fallback: number): number => {
    const value = env[name];
    if (value === undefined || value === "") return fallback;
    if (!/^\d+$/.test(value)) {
      problems.push(`${name} must be a whole number, 0 or more`);
      return fallback;
    }
    return Number(value);
  };

  const appId = text("EB_APP_ID");
  const encodedKey = text("EB_PRIVATE_KEY");
  const privateKey = encodedKey === "" ? null : readKey(encodedKey, problems);
  const redirectUrl = text("EB_REDIRECT_URL");
  if (
    redirectUrl !== "" &&
    !(URL.canParse(redirectUrl) && new URL(redirectUrl).protocol === "https:")
  ) {
    problems.push("EB_REDIRECT_URL must be an https address");
  }
  const configPath = text("CONFIG_PATH");
  const dataDir = text("DATA_DIR");
  const stateDir = text("STATE_DIR");
  const lookbackDays = wholeNumber("LOOKBACK_DAYS", 30);
  const consentWarnDays = wholeNumber("CONSENT_WARN_DAYS", 14);

  if (problems.length > 0 || privateKey === null) return { ok: false, problems };
  return {
    ok: true,
    settings: {
      appId,
      privateKey,
      redirectUrl,
      configPath,
      dataDir,
      stateDir,
      lookbackDays,
      consentWarnDays,
    },
  };
};
