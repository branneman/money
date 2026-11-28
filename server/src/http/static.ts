import { resolve, sep } from "node:path";

// Pure path logic: nothing here touches the filesystem. The caller reads the
// file and answers 404 when there is none.

const MAX_SEGMENT_BYTES = 255;

// Maps a request target to a path inside clientDir, or null for "404".
export const resolveStatic = (clientDir: string, rawPath: string): string | null => {
  if (!rawPath.startsWith("/")) return null;

  const withoutQuery = rawPath.split("?", 1)[0] ?? "";

  let decoded: string;
  try {
    // Exactly once: a second decode would turn "%252e" into a ".".
    decoded = decodeURIComponent(withoutQuery);
  } catch {
    return null; // a malformed escape
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;

  const root = resolve(clientDir);
  if (decoded === "/") return resolve(root, "index.html");

  const segments = decoded.slice(1).split("/");
  // Empty segments (// and a trailing /), ".", ".." and every dotfile.
  if (segments.some((segment) => segment === "" || segment.startsWith("."))) return null;

  // Longer than a filesystem allows: opening it would fail with ENAMETOOLONG, not "missing".
  if (segments.some((segment) => Buffer.byteLength(segment) > MAX_SEGMENT_BYTES)) return null;

  const last = segments[segments.length - 1] ?? "";
  const target = last.includes(".") ? resolve(root, ...segments) : resolve(root, "index.html"); // a client-side route

  // The per-segment refusals above should make this unreachable; it is the
  // belt to their braces.
  return target.startsWith(root + sep) ? target : null;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

// null for an extension that is not served: the caller answers 404.
export const contentTypeOf = (path: string): string | null => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return Object.hasOwn(CONTENT_TYPES, name.slice(dot))
    ? (CONTENT_TYPES[name.slice(dot)] ?? null)
    : null;
};

// esbuild's "[name]-[hash]": the name changes whenever the content does, so a
// year is safe. 5b's build must name its files that way.
const HASHED_NAME = /-[A-Z0-9]{8}\.[a-z0-9.]+$/;

export const cacheControlOf = (path: string): string =>
  HASHED_NAME.test(path) ? "public, max-age=31536000, immutable" : "no-cache";
