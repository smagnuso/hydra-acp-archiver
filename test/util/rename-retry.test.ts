import { strict as assert } from "node:assert";
import { test } from "node:test";
import { renameWithRetry } from "../../src/util/rename-retry.js";

function errWith(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

function harness(failures: string[]) {
  const calls = { rename: 0, sleeps: [] as number[], unlinked: [] as string[] };
  const queue = [...failures];
  return {
    calls,
    deps: {
      rename: async () => {
        calls.rename += 1;
        const code = queue.shift();
        if (code !== undefined) {
          throw errWith(code);
        }
      },
      sleep: async (ms: number) => {
        calls.sleeps.push(ms);
      },
      unlink: async (p: string) => {
        calls.unlinked.push(p);
      },
    },
  };
}

test("renameWithRetry succeeds first time without sleeping", async () => {
  const h = harness([]);
  await renameWithRetry("a.tmp", "a", h.deps);
  assert.equal(h.calls.rename, 1);
  assert.deepEqual(h.calls.sleeps, []);
  assert.deepEqual(h.calls.unlinked, []);
});

test("renameWithRetry retries transient EPERM/EBUSY/EACCES then succeeds", async () => {
  const h = harness(["EPERM", "EBUSY", "EACCES"]);
  await renameWithRetry("a.tmp", "a", h.deps);
  assert.equal(h.calls.rename, 4);
  assert.equal(h.calls.sleeps.length, 3);
  assert.ok(h.calls.sleeps[0]! < h.calls.sleeps[1]! && h.calls.sleeps[1]! < h.calls.sleeps[2]!);
  assert.deepEqual(h.calls.unlinked, []);
});

test("renameWithRetry gives up after 5 attempts, removes tmp, rethrows original", async () => {
  const h = harness(["EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY", "EBUSY"]);
  await assert.rejects(
    renameWithRetry("a.tmp", "a", h.deps),
    (e: NodeJS.ErrnoException) => e.code === "EBUSY",
  );
  assert.equal(h.calls.rename, 5);
  assert.equal(h.calls.sleeps.length, 4);
  assert.deepEqual(h.calls.unlinked, ["a.tmp"]);
});

test("renameWithRetry does not retry non-retryable codes", async () => {
  const h = harness(["ENOENT"]);
  await assert.rejects(
    renameWithRetry("a.tmp", "a", h.deps),
    (e: NodeJS.ErrnoException) => e.code === "ENOENT",
  );
  assert.equal(h.calls.rename, 1);
  assert.deepEqual(h.calls.sleeps, []);
  assert.deepEqual(h.calls.unlinked, ["a.tmp"]);
});

test("renameWithRetry still rethrows the rename error if tmp cleanup fails", async () => {
  const h = harness(["ENOENT"]);
  const deps = {
    ...h.deps,
    unlink: async () => {
      throw errWith("ENOENT");
    },
  };
  await assert.rejects(
    renameWithRetry("a.tmp", "a", deps),
    (e: NodeJS.ErrnoException) => e.code === "ENOENT" && e.message === "ENOENT",
  );
});
