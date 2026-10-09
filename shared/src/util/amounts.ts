// ISO 4217 currencies that do not have two decimals.
const NO_DECIMALS = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);
const THREE_DECIMALS = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export const minorUnits = (currency: string): number =>
  NO_DECIMALS.has(currency) ? 0 : THREE_DECIMALS.has(currency) ? 3 : 2;

// Reads a decimal number as an integer in the currency's smallest unit. Strict on purpose:
// one optional sign, digits, at most one decimal mark, and it must be the expected one.
// A thousands separator therefore fails instead of producing a different number.
export const parseAmount = (text: string, decimal: "." | ",", currency: string): number | null => {
  const match = /^([+-]?)(\d+)(?:([.,])(\d+))?$/.exec(text);
  if (match === null) return null;
  const sign = match[1];
  const whole = match[2];
  const mark = match[3] as string | undefined;
  const fraction = (match[4] as string | undefined) ?? "";
  if (mark !== undefined && mark !== decimal) return null;
  const digits = minorUnits(currency);
  if (fraction.length > digits) return null;
  const value = Number(`${whole}${fraction.padEnd(digits, "0")}`);
  if (!Number.isSafeInteger(value)) return null;
  return sign === "-" && value !== 0 ? -value : value;
};
