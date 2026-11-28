export const LIMIT = { failures: 5, windowMs: 15 * 60 * 1000 } as const;

type Window = { readonly startedAt: number; readonly failures: number };

export type Limiter = {
  /** Whole seconds, rounded up, until the username may try again; null if it may try now. */
  retryAfter(username: string): number | null;
  failed(username: string): void;
  succeeded(username: string): void;
};

// Usernames are typed by whoever reaches the login, so the state is a Map, never an object
// keyed by them. A window starts at a username's first failure and is fixed: later failures
// do not extend it. Expired windows are dropped on every call, which keeps memory bounded by
// what the hash queue lets through in one window.
export const makeLimiter = (clock: () => Date): Limiter => {
  const windows = new Map<string, Window>();

  const dropExpired = (now: number): void => {
    for (const [username, window] of windows) {
      if (now - window.startedAt >= LIMIT.windowMs) windows.delete(username);
    }
  };

  return {
    retryAfter(username) {
      const now = clock().getTime();
      dropExpired(now);
      const window = windows.get(username);
      if (window === undefined || window.failures < LIMIT.failures) return null;
      return Math.ceil((window.startedAt + LIMIT.windowMs - now) / 1000);
    },
    failed(username) {
      const now = clock().getTime();
      dropExpired(now);
      const window = windows.get(username);
      windows.set(
        username,
        window === undefined
          ? { startedAt: now, failures: 1 }
          : { startedAt: window.startedAt, failures: window.failures + 1 },
      );
    },
    succeeded(username) {
      dropExpired(clock().getTime());
      windows.delete(username);
    },
  };
};
