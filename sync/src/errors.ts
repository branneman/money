import { ArchiveError, MergeError } from "@money/shared";

// A failure the sync expects and explains. Its message is composed in this workspace from
// keys, dates, counts and codes, so it may be printed.
export class SyncError extends Error {
  override name = "SyncError";
}

const CONSENT_GONE = [
  "EXPIRED_SESSION",
  "REVOKED_SESSION",
  "CLOSED_SESSION",
  "SESSION_DOES_NOT_EXIST",
];

// What Enable Banking answered instead of a result. The response's own message and detail
// are deliberately not kept: they may say anything.
export class ApiError extends SyncError {
  override name = "ApiError";
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(`Enable Banking answered ${status}${code === null ? "" : ` ${code}`}`);
    this.status = status;
    this.code = code;
  }

  get consentGone(): boolean {
    return this.code !== null && CONSENT_GONE.includes(this.code);
  }
}

export const isExpected = (error: unknown): error is Error =>
  error instanceof SyncError || error instanceof ArchiveError || error instanceof MergeError;

// What may be printed about a failure. Job output leaves the host, and an error nobody
// composed here can quote bank data or a host path in its message.
export const describeError = (error: unknown): string => {
  if (isExpected(error)) return error.message;
  if (!(error instanceof Error)) return "unexpected failure";
  const code = (error as NodeJS.ErrnoException).code;
  const suffix = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? ` ${code}` : "";
  return `unexpected ${error.constructor.name}${suffix}`;
};
