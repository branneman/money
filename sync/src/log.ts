export type Log = (event: string, fields?: Readonly<Record<string, string | number>>) => void;

// Keys, dates, counts and codes. Anything with a space, a comma or a letter outside ASCII
// is not one of those, and is refused rather than printed.
const SAFE = /^[A-Za-z0-9_.:-]*$/;

export const makeLog =
  (out: (line: string) => void): Log =>
  (event, fields = {}) => {
    const parts = Object.entries(fields).map(([key, value]) => {
      const text = String(value);
      if (!SAFE.test(text)) {
        throw new Error(`log field ${key} of ${event} holds something that may not be logged`);
      }
      return `${key}=${text}`;
    });
    out([event, ...parts].join(" "));
  };
