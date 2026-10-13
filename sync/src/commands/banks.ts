// The banks Enable Banking lists for one country. A bank's entry in the configuration file
// must carry its name exactly as listed, and this is where to read it. One request, no
// lock, nothing written.
import type { Context } from "../context.ts";
import { SyncError } from "../errors.ts";

// Each name is printed as JSON, quotes included: that is how the configuration file takes
// it, and a name is text from a response, which must not be able to start a line of its own.
export const runBanks = async (context: Context, country: string): Promise<number> => {
  const names = await context.client.listAspsps(country);
  if (names.length === 0) {
    throw new SyncError(`Enable Banking lists no bank for the country ${country}`);
  }
  for (const name of names) context.deps.out(JSON.stringify(name));
  return 0;
};
