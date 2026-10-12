export type Consent = { expired: boolean; daysLeft: number; warn: boolean };

const DAY = 86_400_000;

// Where a consent stands at an instant. Both times are UTC timestamps.
export const consentAt = (validUntil: string, now: string, warnDays: number): Consent => {
  const left = Date.parse(validUntil) - Date.parse(now);
  return {
    expired: left <= 0,
    daysLeft: Math.max(0, Math.floor(left / DAY)),
    warn: left <= warnDays * DAY,
  };
};
