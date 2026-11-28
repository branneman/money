import type { IncomingHttpHeaders } from "node:http";

// The cross-site check for anything that changes state. Returns the problem,
// or null when the request is same-origin. The text is for tests; it never
// carries a header's value, so it is safe to log.
export const crossSiteProblem = (headers: IncomingHttpHeaders): string | null => {
  const { host, origin } = headers;
  const fetchSite = headers["sec-fetch-site"];

  if (origin === undefined) return "no Origin header";
  if (host === undefined) return "no Host header";

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "null" and anything else that is not a URL: refused, not guessed at.
    return "Origin does not parse";
  }
  if (originHost !== host) return "Origin does not name this Host";

  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    return "Sec-Fetch-Site is not same-origin";
  }
  return null;
};
