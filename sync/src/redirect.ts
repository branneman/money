import { SyncError } from "./errors.ts";

// Reads the code out of the address the user pastes back after approving at the bank.
// That page does not load; only its address matters. No message repeats what was pasted.
export const readRedirect = (pasted: string, redirectUrl: string, state: string): string => {
  const text = pasted.trim();
  if (!URL.canParse(text)) {
    throw new SyncError("that is not an address. Paste the whole address the browser was sent to.");
  }
  const landed = new URL(text);
  const expected = new URL(redirectUrl);
  if (landed.origin !== expected.origin || landed.pathname !== expected.pathname) {
    throw new SyncError("that is not the redirect address of this application");
  }
  const error = landed.searchParams.get("error");
  if (error !== null) {
    const code = /^[a-z_]+$/.test(error) ? ` (${error})` : "";
    throw new SyncError(`the bank did not grant the consent${code}`);
  }
  if (landed.searchParams.get("state") !== state) {
    throw new SyncError(
      "that address belongs to another authorisation: its state does not match. Start again.",
    );
  }
  const code = landed.searchParams.get("code");
  if (code === null || code === "") throw new SyncError("that address carries no code");
  return code;
};
