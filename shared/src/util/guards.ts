// A plain object: not null, not an array.
export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A string with something in it.
export const isText = (value: unknown): value is string =>
  typeof value === "string" && value !== "";
