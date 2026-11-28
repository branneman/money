import type { IncomingHttpHeaders } from "node:http";

// The cross-site check for anything that changes state. Returns the problem,
// or null when the request is same-origin. The text is for tests; it never
// carries a header's value, so it is safe to log.
export const crossSiteProblem = (headers: IncomingHttpHeaders): string | null => {
  const { host, origin } = headers;
  const fetchSite = headers["sec-fetch-site"];

  if (origin === undefined) return "no Origin header";
  if (host === undefined) return "no Host header";

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    // "null" and anything else that is not a URL: refused, not guessed at.
    return "Origin does not parse";
  }
  // A browser sends only scheme://host[:port], already in canonical form. Anything that
  // changes when parsed and written again (userinfo, a path, upper case) is not from one.
  if (parsed.origin !== origin) return "Origin is not in canonical form";
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Origin is not http(s)";
  if (parsed.host === "") return "Origin has no host";
  if (parsed.host !== host) return "Origin does not name this Host";

  if (fetchSite !== undefined && fetchSite !== "same-origin") {
    return "Sec-Fetch-Site is not same-origin";
  }
  return null;
};
