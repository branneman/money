export const QUEUE_LIMIT = 8;

export type Queue = {
  /** Null at once when `limit` tasks are already waiting; the running one does not count. */
  run<T>(task: () => Promise<T>): Promise<T> | null;
};

// One scrypt check costs a quarter-second and 128 MiB, so checks run one at a time, and only
// a few may wait: beyond that the caller answers 503 rather than letting a pile grow.
export const makeQueue = (limit: number): Queue => {
  const waiting: Array<() => void> = [];
  let running = false;

  const startNext = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
      running = false;
      return;
    }
    next();
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> | null {
      if (running && waiting.length >= limit) return null;
      return new Promise<T>((resolve, reject) => {
        const start = (): void => {
          running = true;
          // A task that throws before returning a promise is a rejection like any other.
          new Promise<T>((done) => done(task())).then(resolve, reject).finally(startNext);
        };
        if (running) waiting.push(start);
        else start();
      });
    },
  };
};
