// What a route answers, as data. The handler writes it, with the headers every response
// carries; a route never touches the response itself.
export type Reply = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Buffer;
};

const JSON_TYPE = "application/json; charset=utf-8";

export const json = (
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): Reply => ({
  status,
  headers: { "Content-Type": JSON_TYPE, ...headers },
  body: JSON.stringify(value),
});

export const noContent = (headers: Readonly<Record<string, string>> = {}): Reply => ({
  status: 204,
  headers,
  body: "",
});

// A request whose body was never read, or only partly, is answered and then closed, so
// what is left of it is never read as the next request on the connection.
const CLOSE = { Connection: "close" };

export const LOGIN_REFUSED = json(401, { error: "login refused" });
export const NOT_FOUND = json(404, { error: "not found" });
export const REFUSED = json(403, { error: "refused" });
export const CROSS_SITE = json(403, { error: "refused" }, CLOSE);
export const UNAVAILABLE = json(503, { error: "unavailable" });
export const FAILED = json(500, { error: "failed" });

export const methodNotAllowed = (allowed: string): Reply =>
  json(405, { error: "method not allowed" }, { Allow: allowed });

export const tooManyAttempts = (retryAfter: number): Reply =>
  json(429, { error: "too many attempts" }, { "Retry-After": String(retryAfter) });

export const BODY_REFUSED: Readonly<Record<400 | 413 | 415, Reply>> = {
  400: json(400, { error: "bad request" }),
  413: json(413, { error: "too large" }, CLOSE),
  415: json(415, { error: "unsupported media type" }, CLOSE),
};
