import { test } from "node:test";
import assert from "node:assert/strict";
import { QUEUE_LIMIT, makeQueue } from "./queue.ts";

const later = () => new Promise<void>((resolve) => setImmediate(resolve));

const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
};

test("the queue holds eight waiting", () => {
  assert.equal(QUEUE_LIMIT, 8);
});

test("two tasks never overlap, and run in order", async () => {
  const queue = makeQueue(8);
  const events: string[] = [];
  const task = (name: string) => async () => {
    events.push(`start ${name}`);
    await later();
    await later();
    events.push(`end ${name}`);
    return name;
  };
  const results = await Promise.all(
    ["a", "b", "c"].map((name) => {
      const promise = queue.run(task(name));
      assert.ok(promise !== null);
      return promise;
    }),
  );
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(events, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("with one running and the limit waiting, the next run returns null", async () => {
  const queue = makeQueue(8);
  const { open, opened } = gate();
  const promises = [queue.run(() => opened)];
  for (let i = 0; i < 8; i++) promises.push(queue.run(() => Promise.resolve(undefined)));
  assert.ok(promises.every((promise) => promise !== null));
  assert.equal(
    queue.run(() => Promise.resolve(undefined)),
    null,
  );
  open();
  await Promise.all(promises);
  assert.notEqual(
    queue.run(() => Promise.resolve(undefined)),
    null,
  );
});

test("the running task does not count as waiting", async () => {
  const queue = makeQueue(1);
  const { open, opened } = gate();
  const running = queue.run(() => opened);
  const waiting = queue.run(() => Promise.resolve("second"));
  assert.notEqual(running, null);
  assert.notEqual(waiting, null);
  assert.equal(
    queue.run(() => Promise.resolve("third")),
    null,
  );
  open();
  assert.equal(await waiting, "second");
});

test("a limit of zero lets one run and refuses any that would wait", async () => {
  const queue = makeQueue(0);
  const { open, opened } = gate();
  const running = queue.run(() => opened);
  assert.notEqual(running, null);
  assert.equal(
    queue.run(() => Promise.resolve(undefined)),
    null,
  );
  open();
  await running;
});

test("a task that rejects rejects its own promise and the next still runs", async () => {
  const queue = makeQueue(8);
  const failing = queue.run(() => Promise.reject(new Error("boom")));
  const next = queue.run(() => Promise.resolve("fine"));
  assert.ok(failing !== null && next !== null);
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "fine");
});

test("a task that throws synchronously is a rejection too", async () => {
  const queue = makeQueue(8);
  const failing = queue.run((): Promise<string> => {
    throw new Error("sync boom");
  });
  const next = queue.run(() => Promise.resolve("fine"));
  assert.ok(failing !== null && next !== null);
  await assert.rejects(failing, /sync boom/);
  assert.equal(await next, "fine");
});
