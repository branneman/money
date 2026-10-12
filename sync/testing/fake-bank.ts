// A bank behind the Enable Banking API, held in memory and handed to the code as its
// fetch. It answers from its state rather than from canned responses, so tests can
// generate histories freely. Its shapes are taken from the API reference and are still to
// be checked against the sandbox. Everything in it is invented.
import { createVerify } from "node:crypto";
import type { KeyObject } from "node:crypto";

import { isObject, isText } from "@money/shared";

import type { Fetch } from "../src/enablebanking/client.ts";
import { addDays } from "../src/time.ts";
import type { Clock } from "../src/time.ts";

// One version of a transaction, current from `from` onward. A null `raw` means the bank
// withdrew the transaction from then on.
export type FakeVersion = { from: string; raw: Record<string, unknown> | null };
export type FakeAccount = { iban: string; transactions: FakeVersion[][] };

export type FakeAspsp = {
  name: string;
  country: string;
  maximumConsentValidity: number;
  requiredPsuHeaders: string[];
  // How far back a session reaches once the user is no longer present.
  unattendedDays: number;
  ignoresStatusFilter: boolean;
  accounts: FakeAccount[];
};

export type Failure = { status: number; error: string } | { network: true } | { body: string };

export type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | undefined;
};

export type FakeBank = {
  fetch: Fetch;
  requests: RecordedRequest[];
  // Every transaction the bank ever returned, in the order it returned them.
  served: { iban: string; raw: Record<string, unknown> }[];
  pageSize: number;
  // Plays the user approving at the bank: returns the address the browser lands on.
  approve: (url: string, options?: { only?: readonly string[] }) => string;
  // Makes the nth request from now fail.
  failRequest: (n: number, failure: Failure) => void;
  // Forgets every failure that has not happened yet.
  clearFailures: () => void;
  revoke: (aspspName: string) => void;
};

type Answer = { status: number; text: () => Promise<string> };
type Session = {
  aspsp: FakeAspsp;
  validUntil: number;
  authorisedAt: number;
  uids: Map<string, FakeAccount>;
  revoked: boolean;
};

const HOUR = 3_600_000;
const QUERY_NAMES = ["date_from", "date_to", "strategy", "transaction_status", "continuation_key"];
const STATUSES = ["BOOK", "CNCL", "HOLD", "OTHR", "PDNG", "RJCT", "SCHD"];

const isCalendarDate = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

export const makeFakeBank = (options: {
  clock: Clock;
  publicKey: KeyObject;
  appId: string;
  redirectUrl: string;
  aspsps: FakeAspsp[];
}): FakeBank => {
  const { clock, publicKey, appId, redirectUrl, aspsps } = options;
  const pending = new Map<string, { aspsp: FakeAspsp; state: string; validUntil: number }>();
  const codes = new Map<
    string,
    { aspsp: FakeAspsp; validUntil: number; only: readonly string[] | null }
  >();
  const sessions = new Map<string, Session>();
  const failures = new Map<number, Failure>();
  // Every continuation key the bank issued, with what it was issued for and the list it
  // pages through, fixed when the first page was asked.
  const issued = new Map<
    string,
    { uid: string; query: string; list: Record<string, unknown>[] }[]
  >();
  let counter = 0;
  let received = 0;

  const nextId = (): string => {
    counter += 1;
    return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
  };
  const answer = (status: number, body: unknown): Answer => ({
    status,
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
  // The message and detail are there to be recognised: nothing may ever print them.
  const refuse = (status: number, error: string): Answer =>
    answer(status, {
      code: status,
      error,
      message: "Recognisable message about NL00BNKA0000000001",
      detail: "Recognisable detail",
    });

  const decode = (part: string): Record<string, unknown> => {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
    return isObject(value) ? value : {};
  };
  const tokenIsValid = (authorization: string | undefined): boolean => {
    const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : "";
    const [head, claims, signature, ...rest] = token.split(".");
    if (head === undefined || claims === undefined || signature === undefined || rest.length > 0) {
      return false;
    }
    try {
      const signed = createVerify("RSA-SHA256")
        .update(`${head}.${claims}`)
        .verify(publicKey, signature, "base64url");
      const header = decode(head);
      const body = decode(claims);
      const now = Math.floor(clock().getTime() / 1000);
      return (
        signed &&
        header.alg === "RS256" &&
        header.kid === appId &&
        body.iss === "enablebanking.com" &&
        body.aud === "api.enablebanking.com" &&
        typeof body.iat === "number" &&
        typeof body.exp === "number" &&
        body.iat <= now &&
        now < body.exp &&
        body.exp - body.iat <= 86_400
      );
    } catch {
      return false;
    }
  };

  const bank: FakeBank = {
    fetch: (url, init) => new Promise((resolve) => resolve(handle(url, init))),
    requests: [],
    served: [],
    pageSize: 100,
    approve: (url, approval = {}) => {
      const id = new URL(url).searchParams.get("authorization") ?? "";
      const waiting = pending.get(id);
      if (waiting === undefined) throw new Error("the fake bank has no such authorisation");
      pending.delete(id);
      const code = nextId();
      codes.set(code, {
        aspsp: waiting.aspsp,
        validUntil: waiting.validUntil,
        only: approval.only ?? null,
      });
      const query = new URLSearchParams({ state: waiting.state, code });
      return `${redirectUrl}?${query.toString()}`;
    },
    failRequest: (n, failure) => {
      if (!Number.isInteger(n) || n < 1) {
        throw new Error("failRequest needs a positive whole number of requests");
      }
      failures.set(received + n, failure);
    },
    clearFailures: () => {
      failures.clear();
    },
    revoke: (aspspName) => {
      for (const session of sessions.values()) {
        if (session.aspsp.name === aspspName) session.revoked = true;
      }
    },
  };

  const listAspsps = (query: URLSearchParams): Answer =>
    answer(200, {
      aspsps: aspsps
        .filter((aspsp) => aspsp.country === query.get("country"))
        .map((aspsp) => ({
          name: aspsp.name,
          country: aspsp.country,
          maximum_consent_validity: aspsp.maximumConsentValidity,
          required_psu_headers: aspsp.requiredPsuHeaders,
        })),
    });

  const startAuth = (body: unknown): Answer => {
    if (!isObject(body) || !isObject(body.aspsp) || !isObject(body.access)) {
      return refuse(400, "WRONG_REQUEST_PARAMETERS");
    }
    const wanted = body.aspsp;
    const aspsp = aspsps.find(
      (item) => item.name === wanted.name && item.country === wanted.country,
    );
    if (aspsp === undefined) return refuse(400, "WRONG_ASPSP_PROVIDED");
    if (body.redirect_url !== redirectUrl) return refuse(400, "REDIRECT_URI_NOT_ALLOWED");
    const validUntil = Date.parse(String(body.access.valid_until));
    const latest = clock().getTime() + aspsp.maximumConsentValidity * 1000;
    if (!isText(body.state) || Number.isNaN(validUntil) || validUntil > latest) {
      return refuse(400, "WRONG_REQUEST_PARAMETERS");
    }
    const id = nextId();
    pending.set(id, { aspsp, state: body.state, validUntil });
    return answer(200, {
      url: `https://bank.example/approve?authorization=${id}`,
      authorization_id: id,
    });
  };

  const createSession = (body: unknown): Answer => {
    const code = isObject(body) && typeof body.code === "string" ? body.code : "";
    const approved = codes.get(code);
    if (approved === undefined) return refuse(400, "WRONG_AUTHORIZATION_CODE");
    codes.delete(code);
    const covered = approved.aspsp.accounts.filter(
      (account) => approved.only === null || approved.only.includes(account.iban),
    );
    const session: Session = {
      aspsp: approved.aspsp,
      validUntil: approved.validUntil,
      authorisedAt: clock().getTime(),
      uids: new Map(covered.map((account) => [nextId(), account])),
      revoked: false,
    };
    const sessionId = nextId();
    sessions.set(sessionId, session);
    return answer(200, {
      session_id: sessionId,
      accounts: [...session.uids].map(([uid, account]) => ({
        account_id: { iban: account.iban },
        uid,
        currency: "EUR",
        cash_account_type: "CACC",
        identification_hash: uid,
        identification_hashes: [uid],
      })),
      aspsp: { name: approved.aspsp.name, country: approved.aspsp.country },
      psu_type: "personal",
      access: { valid_until: new Date(approved.validUntil).toISOString() },
    });
  };

  const transactions = (uid: string, query: URLSearchParams): Answer => {
    const session = [...sessions.values()].find((item) => item.uids.has(uid));
    const account = session?.uids.get(uid);
    if (session === undefined || account === undefined) {
      return refuse(404, "ACCOUNT_DOES_NOT_EXIST");
    }
    const now = clock().getTime();
    if (session.revoked) return refuse(401, "REVOKED_SESSION");
    if (now >= session.validUntil) return refuse(401, "EXPIRED_SESSION");

    for (const name of query.keys()) {
      if (!QUERY_NAMES.includes(name)) return refuse(422, "WRONG_REQUEST_PARAMETERS");
    }
    const strategy = query.get("strategy");
    const status = query.get("transaction_status");
    const asked = query.get("date_from");
    const until = query.get("date_to");
    if (strategy !== null && strategy !== "default" && strategy !== "longest") {
      return refuse(422, "WRONG_REQUEST_PARAMETERS");
    }
    if (status !== null && !STATUSES.includes(status)) {
      return refuse(422, "WRONG_REQUEST_PARAMETERS");
    }
    for (const date of [asked, until]) {
      if (date !== null && !isCalendarDate(date)) return refuse(422, "WRONG_REQUEST_PARAMETERS");
    }
    if (asked !== null && until !== null && asked > until) {
      return refuse(422, "WRONG_TRANSACTIONS_PERIOD");
    }

    const requested = JSON.stringify(
      [...query].filter(([name]) => name !== "continuation_key").toSorted(),
    );
    const key = query.get("continuation_key");
    if (key !== null) {
      const match = /^k-(\d+)-(\d+)$/.exec(key);
      const entry = issued.get(key)?.find((item) => item.uid === uid && item.query === requested);
      if (match === null || entry === undefined) return refuse(400, "WRONG_CONTINUATION_KEY");
      return page(entry.list, Number(match[1]), Number(match[2]), uid, requested, account);
    }

    const today = new Date(now).toISOString().slice(0, 10);
    const fresh = now - session.authorisedAt < HOUR;
    const reach = fresh ? "0000-01-01" : addDays(today, -session.aspsp.unattendedDays);
    const longest = strategy === "longest";
    if (!longest && asked !== null && asked < reach) {
      return refuse(422, "WRONG_TRANSACTIONS_PERIOD");
    }
    const from = asked === null || asked < reach ? reach : asked;
    const to = longest ? "9999-12-31" : (until ?? "9999-12-31");
    const filter = session.aspsp.ignoresStatusFilter ? null : status;

    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const list = account.transactions
      .flatMap((versions) => {
        const version = versions.findLast((item) => Date.parse(item.from) <= now);
        return version === undefined || version.raw === null ? [] : [version.raw];
      })
      .filter((raw) => {
        const date = raw.booking_date;
        return typeof date !== "string" || (date >= from && date <= to);
      })
      .filter((raw) => filter === null || raw.status === filter)
      .toSorted((a, b) => {
        const left = `${text(a.booking_date)} ${text(a.entry_reference)}`;
        const right = `${text(b.booking_date)} ${text(b.entry_reference)}`;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    return page(list, 0, now, uid, requested, account);
  };

  const page = (
    list: Record<string, unknown>[],
    offset: number,
    asOf: number,
    uid: string,
    query: string,
    account: FakeAccount,
  ): Answer => {
    const end = offset + bank.pageSize;
    const items = list.slice(offset, end);
    for (const raw of items) bank.served.push({ iban: account.iban, raw });
    if (end >= list.length) return answer(200, { transactions: items, continuation_key: null });
    const key = `k-${end}-${asOf}`;
    issued.set(key, [...(issued.get(key) ?? []), { uid, query, list }]);
    return answer(200, { transactions: items, continuation_key: key });
  };

  // Undefined when the body is not JSON.
  const parseBody = (text: string | undefined): { value: unknown } | undefined => {
    try {
      return { value: JSON.parse(text ?? "null") };
    } catch (error) {
      if (error instanceof SyntaxError) return undefined;
      throw error;
    }
  };

  const handle = (url: string, init: Parameters<Fetch>[1]): Answer => {
    received += 1;
    const address = new URL(url);
    const headers = Object.fromEntries(
      Object.entries(init.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    bank.requests.push({
      method: init.method,
      path: address.pathname,
      query: Object.fromEntries(address.searchParams),
      headers,
      body: init.body,
    });

    const failure = failures.get(received);
    if (failure !== undefined) {
      failures.delete(received);
      if ("network" in failure) throw new TypeError("fetch failed");
      if ("body" in failure) return answer(200, failure.body);
      return refuse(failure.status, failure.error);
    }
    if (!tokenIsValid(headers.authorization)) return refuse(401, "UNAUTHORIZED_ACCESS");

    const route = `${init.method} ${address.pathname}`;
    if (route === "GET /aspsps") return listAspsps(address.searchParams);
    if (route === "POST /auth" || route === "POST /sessions") {
      const body = parseBody(init.body);
      if (body === undefined) return refuse(400, "WRONG_REQUEST_PARAMETERS");
      return route === "POST /auth" ? startAuth(body.value) : createSession(body.value);
    }
    const account = /^\/accounts\/([^/]+)\/transactions$/.exec(address.pathname);
    if (init.method === "GET" && account !== null) {
      return transactions(decodeURIComponent(account[1]), address.searchParams);
    }
    return refuse(404, "WRONG_REQUEST_PARAMETERS");
  };

  return bank;
};
