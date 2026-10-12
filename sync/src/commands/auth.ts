// Starts or renews the consent for one bank, then fetches. Interactive: the user approves
// at the bank and pastes back the address the browser was sent to.
import type { Context } from "../context.ts";
import { SyncError } from "../errors.ts";
import { readRedirect } from "../redirect.ts";
import { readState, renewed, writeState } from "../state.ts";
import { dateOf, timestampOf } from "../time.ts";
import { fetchable, fetchAccounts } from "./account.ts";

// An IBAN as it is compared: people write them with spaces, banks without.
const plain = (iban: string): string => iban.replaceAll(/\s/g, "").toUpperCase();

export const runAuth = async (context: Context, bank: string): Promise<number> => {
  const { settings, config, client, deps, log } = context;
  // What was typed is not repeated: it may be anything.
  if (!Object.hasOwn(config.banks, bank)) {
    throw new SyncError("that bank is not in the configuration");
  }
  const accounts = fetchable(config).get(bank) ?? [];
  if (accounts.length === 0) {
    throw new SyncError(
      `${bank} has no open account with an iban, so there is nothing to authorise`,
    );
  }
  // Read first, so that state the sync cannot use is found before the user goes to the bank.
  const previous = await readState(settings.stateDir, bank);

  const { aspsp } = config.banks[bank];
  const listed = await client.findAspsp(aspsp.name, aspsp.country);
  if (listed === null) {
    throw new SyncError(
      `${bank}: Enable Banking lists no bank under the configured name and country`,
    );
  }
  const required = listed.requiredPsuHeaders.join(", ");
  deps.out(`PSU headers this bank lists as required: ${required === "" ? "none" : required}`);

  const state = deps.randomState();
  const validUntil = timestampOf(
    new Date(deps.clock().getTime() + listed.maximumConsentValidity * 1000),
  );
  const { url } = await client.startAuth({
    aspsp,
    state,
    redirectUrl: settings.redirectUrl,
    validUntil,
  });
  deps.out(
    "Open this address and approve. The browser is then sent to a page that does not load; that is expected.",
  );
  deps.out(url);
  const pasted = await deps.readLine("Paste the whole address of that page: ");
  const session = await client.createSession(readRedirect(pasted, settings.redirectUrl, state));

  const uids: Record<string, string> = {};
  const problems: string[] = [];
  for (const account of accounts) {
    const configured = config.accounts[account].iban;
    if (configured === undefined) throw new SyncError(`${account} has no iban`);
    const iban = plain(configured);
    const matching = session.accounts.filter(
      (item) => item.iban !== null && plain(item.iban) === iban,
    );
    if (matching.length === 0) problems.push(`${account}: the consent does not cover it`);
    else if (matching.length > 1) {
      problems.push(`${account}: the consent covers more than one account with its iban`);
    } else if (matching[0].uid === null) {
      problems.push(`${account}: the consent covers it but gives no way to fetch it`);
    } else uids[account] = matching[0].uid;
  }
  if (problems.length > 0) throw new SyncError(problems.join("\n"));

  await writeState(settings.stateDir, bank, renewed(previous, session, uids));
  log("authorised", {
    bank,
    accounts: accounts.length,
    ignored: session.accounts.length - accounts.length,
    until: dateOf(session.validUntil),
  });

  // At once, before returning: a bank may serve older history only while the user has
  // just authenticated, and that fetch may not be repeatable.
  const outcome = await fetchAccounts(
    context,
    bank,
    accounts.map((account) => [account, uids[account]] as const),
    // Decided from the state as it was found, before anything left in the inbox is merged:
    // a completed run from before the state was lost must not stand in for the history.
    new Set(accounts.filter((account) => previous?.accounts[account]?.last_success === undefined)),
  );
  if (outcome.failed.length > 0) {
    deps.out(
      `The consent is stored. Not fetched in full: ${outcome.failed.join(", ")}. Run sync to continue.`,
    );
    return 1;
  }
  return outcome.newlyMissing > 0 ? 1 : 0;
};
