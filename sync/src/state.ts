// What the sync remembers between runs: per bank, the session and what each account has
// reached. Rebuildable by running auth again, and never backed up, since it holds a live
// session id.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ACCOUNT_KEY, isObject, isText, isTimestamp } from "@money/shared";

import { writeAtomic } from "./atomic.ts";
import { isJson } from "./enablebanking/responses.ts";
import { SyncError } from "./errors.ts";

export type AccountState = {
  // The bank's id for the account under the current session. It changes with every consent.
  uid: string;
  // The start of the last fetch that was received in full and written. Absent until then.
  last_success?: string;
  // Ids of stored records the last window fetch should have returned and did not.
  missing: string[];
};

export type BankState = {
  session_id: string;
  valid_until: string;
  accounts: Record<string, AccountState>;
};

const isAccountState = (value: unknown): value is AccountState =>
  isObject(value) &&
  isText(value.uid) &&
  (value.last_success === undefined ||
    (typeof value.last_success === "string" && isTimestamp(value.last_success))) &&
  Array.isArray(value.missing) &&
  value.missing.every(isText);

const isBankState = (value: unknown): value is BankState =>
  isObject(value) &&
  isText(value.session_id) &&
  typeof value.valid_until === "string" &&
  isTimestamp(value.valid_until) &&
  isObject(value.accounts) &&
  Object.entries(value.accounts).every(
    ([key, account]) => ACCOUNT_KEY.test(key) && isAccountState(account),
  );

const pathOf = (stateDir: string, bank: string): string => join(stateDir, `${bank}.json`);

export const readState = async (stateDir: string, bank: string): Promise<BankState | null> => {
  let text: string;
  try {
    text = await readFile(pathOf(stateDir, bank), "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  // Text that is not JSON gets the same refusal as any other state the sync did not write.
  const parsed: unknown = isJson(text) ? JSON.parse(text) : null;
  if (!isBankState(parsed)) {
    throw new SyncError(
      `the stored state of ${bank} is not what the sync wrote. Remove it and run: auth ${bank}`,
    );
  }
  return parsed;
};

export const writeState = (stateDir: string, bank: string, state: BankState): Promise<void> =>
  writeAtomic(pathOf(stateDir, bank), `${JSON.stringify(state, null, 2)}\n`);

// The state after an authorisation. The session and every uid are new. What an account had
// already reached is kept, so a renewal continues from the last success instead of asking
// for the whole history again.
export const renewed = (
  previous: BankState | null,
  session: { sessionId: string; validUntil: string },
  uids: Readonly<Record<string, string>>,
): BankState => ({
  session_id: session.sessionId,
  valid_until: session.validUntil,
  accounts: Object.fromEntries(
    Object.keys(uids)
      .toSorted()
      .map((account): [string, AccountState] => {
        const before = previous?.accounts[account];
        return [
          account,
          {
            uid: uids[account],
            ...(before?.last_success === undefined ? {} : { last_success: before.last_success }),
            missing: before?.missing ?? [],
          },
        ];
      }),
  ),
});

export const withSuccess = (
  state: BankState,
  account: string,
  started: string,
  missing: readonly string[],
): BankState => ({
  ...state,
  accounts: {
    ...state.accounts,
    [account]: { uid: state.accounts[account].uid, last_success: started, missing: [...missing] },
  },
});
