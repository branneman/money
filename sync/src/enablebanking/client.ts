import { isObject } from "@money/shared";

import { ApiError, SyncError } from "../errors.ts";
import type { Window } from "../window.ts";
import { checkAuthStart, checkSession, findAspsp, parseJson } from "./responses.ts";
import type { Aspsp, Session } from "./responses.ts";

// As much of `fetch` as the client uses. The built-in fetch satisfies it, and so does the
// fake bank.
export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; text: () => Promise<string> }>;

// Sandbox and production share this address. Which one a request reaches is decided by the
// application the token names.
export const BASE_URL = "https://api.enablebanking.com";

// A deep backfill makes the bank work, so the limit is generous. There is no retry: banks
// allow few unattended fetches a day.
const TIMEOUT_MS = 120_000;

export type AuthRequest = {
  aspsp: { name: string; country: string };
  state: string;
  redirectUrl: string;
  validUntil: string;
};

export type Client = {
  findAspsp: (name: string, country: string) => Promise<Aspsp | null>;
  startAuth: (request: AuthRequest) => Promise<{ url: string }>;
  createSession: (code: string) => Promise<Session>;
  transactionsPage: (
    uid: string,
    window: Window,
    continuationKey: string | null,
  ) => Promise<string>;
};

// The error code of a failed response, when it has one that is only capitals and
// underscores. The response's message and detail may say anything and are not read.
const errorCodeOf = (text: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isObject(parsed) && typeof parsed.error === "string" && /^[A-Z_]+$/.test(parsed.error)
    ? parsed.error
    : null;
};

// `token` is asked for a token with every request. One minted when the command starts would
// expire under a user who takes an hour at the bank, or under a long backfill.
export const makeClient = (fetch: Fetch, token: () => string): Client => {
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<string> => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token()}`,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    let status: number;
    let text: string;
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      // A timeout is a DOMException whose name says what happened. A name is free text,
      // so only a plain word is printed, and otherwise the class.
      const kind = !(error instanceof Error)
        ? "unknown"
        : /^[A-Za-z]+$/.test(error.name)
          ? error.name
          : error.constructor.name;
      throw new SyncError(`no answer from Enable Banking (${kind})`);
    }
    if (status !== 200) throw new ApiError(status, errorCodeOf(text));
    return text;
  };

  return {
    findAspsp: async (name, country) => {
      const text = await send("GET", `/aspsps?${new URLSearchParams({ country }).toString()}`);
      return findAspsp(parseJson(text, "the list of banks"), name, country);
    },
    startAuth: async (request) => {
      const text = await send("POST", "/auth", {
        access: { valid_until: request.validUntil, balances: false, transactions: true },
        aspsp: request.aspsp,
        state: request.state,
        redirect_url: request.redirectUrl,
        psu_type: "personal",
      });
      return checkAuthStart(parseJson(text, "the authorisation"));
    },
    createSession: async (code) => {
      const text = await send("POST", "/sessions", { code });
      return checkSession(parseJson(text, "the session"));
    },
    transactionsPage: (uid, window, continuationKey) => {
      const query = new URLSearchParams({ transaction_status: "BOOK" });
      if (window.strategy === "longest") {
        query.set("strategy", "longest");
      } else {
        query.set("date_from", window.dateFrom);
        query.set("date_to", window.dateTo);
      }
      if (continuationKey !== null) query.set("continuation_key", continuationKey);
      return send("GET", `/accounts/${encodeURIComponent(uid)}/transactions?${query.toString()}`);
    },
  };
};
