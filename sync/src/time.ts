export type Clock = () => Date;

// UTC in whole seconds, the one notation the archive accepts.
export const timestampOf = (date: Date): string => `${date.toISOString().slice(0, 19)}Z`;

// The UTC calendar date of a timestamp written by timestampOf.
export const dateOf = (timestamp: string): string => timestamp.slice(0, 10);

export const addDays = (date: string, days: number): string => {
  const moved = new Date(`${date}T00:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
};

// 2026-10-11T03:00:00Z becomes 20261011T030000Z: fixed width, so names sort by time.
export const runNameOf = (timestamp: string): string =>
  timestamp.replaceAll("-", "").replaceAll(":", "");
