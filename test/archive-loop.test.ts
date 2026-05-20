import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchiveLoop, type SessionMeta } from "../src/archive-loop.js";
import { FsBackend } from "../src/backend/fs.js";
import { deserialize } from "../src/envelope.js";
import { SyncState } from "../src/state.js";
import type { DaemonClient, SessionBundle } from "../src/daemon.js";

const LINEAGE = "hydra_lineage_aaaa1111bbbb2222";
const HOST = { host: "fake-host", user: "fake-user" };

function fakeBundle(history: unknown[] = []): SessionBundle {
  return {
    version: 1,
    exportedAt: "2026-05-20T00:00:00.000Z",
    session: { sessionId: "s1", lineageId: LINEAGE, cwd: "/tmp/x" },
    history,
  };
}

interface FixtureOpts {
  bundleProvider?: () => SessionBundle;
}

function fixture(opts: FixtureOpts = {}): {
  loop: ArchiveLoop;
  backend: FsBackend;
  state: SyncState;
  exports: number;
  bundleDir: string;
  cleanup: () => Promise<void>;
} {
  const dir = mkdtempSync(join(tmpdir(), "archiver-archive-"));
  const bundleDir = join(dir, "backend");
  const stateFile = join(dir, "state.json");
  const backend = new FsBackend({ dir: bundleDir });
  const state = new SyncState(stateFile);
  let exports = 0;
  const provider = opts.bundleProvider ?? (() => fakeBundle());
  const daemon: Partial<DaemonClient> = {
    exportSession: async () => {
      exports += 1;
      return provider();
    },
  };
  const ref = { exports: 0 };
  const loop = new ArchiveLoop({
    daemon: daemon as DaemonClient,
    backend,
    state,
    getRule: () => () => true,
    debounceMs: 5,
    host: HOST,
  });
  // expose exports through a closure ref
  Object.defineProperty(ref, "exports", { get: () => exports });
  return {
    loop,
    backend,
    state,
    get exports() {
      return exports;
    },
    bundleDir,
    cleanup: async () => {
      loop.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  } as unknown as ReturnType<typeof fixture>;
}

test("flushNow exports the session, uploads, and records hash in state", async () => {
  const f = fixture();
  try {
    await f.backend.init();
    await f.state.load();
    await f.loop.flushNow("s1");
    const entries = await f.backend.list();
    assert.equal(entries.length, 1);
    const env = deserialize(await f.backend.get(entries[0]!.key));
    assert.equal(env.lineageId, LINEAGE);
    assert.equal(env.uploadedBy.host, HOST.host);
    const lineage = f.state.get(LINEAGE);
    assert.equal(lineage.lastUploadedHash, env.bundleHash);
  } finally {
    await f.cleanup();
  }
});

test("identical bundle on second flush skips the upload", async () => {
  const f = fixture();
  try {
    await f.backend.init();
    await f.state.load();
    await f.loop.flushNow("s1");
    const firstHash = f.state.get(LINEAGE).lastUploadedHash;
    const firstUploadedAt = f.state.get(LINEAGE).lastUploadedAt;
    await new Promise((r) => setTimeout(r, 5));
    await f.loop.flushNow("s1");
    // hash unchanged, but more importantly the upload was skipped
    // — proxy: lastUploadedAt didn't change because we never called put.
    assert.equal(f.state.get(LINEAGE).lastUploadedHash, firstHash);
    assert.equal(f.state.get(LINEAGE).lastUploadedAt, firstUploadedAt);
  } finally {
    await f.cleanup();
  }
});

test("debounce collapses bursts into one upload", async () => {
  // Capture how many times exportSession was called.
  let exports = 0;
  const dir = mkdtempSync(join(tmpdir(), "archiver-debounce-"));
  try {
    const backend = new FsBackend({ dir: join(dir, "backend") });
    await backend.init();
    const state = new SyncState(join(dir, "state.json"));
    await state.load();
    const daemon: Partial<DaemonClient> = {
      exportSession: async () => {
        exports += 1;
        return fakeBundle();
      },
    };
    const loop = new ArchiveLoop({
      daemon: daemon as DaemonClient,
      backend,
      state,
      getRule: () => () => true,
      debounceMs: 30,
      host: HOST,
    });
    for (let i = 0; i < 5; i++) {
      loop.markDirty("s1");
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 80));
    loop.stop();
    assert.equal(exports, 1, `expected single export, got ${exports}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule returning false skips upload", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-skip-"));
  try {
    const backend = new FsBackend({ dir: join(dir, "backend") });
    await backend.init();
    const state = new SyncState(join(dir, "state.json"));
    await state.load();
    const daemon: Partial<DaemonClient> = {
      exportSession: async () => fakeBundle(),
    };
    const meta: SessionMeta = { cwd: "/blocked" };
    const loop = new ArchiveLoop({
      daemon: daemon as DaemonClient,
      backend,
      state,
      getRule: () => (ev) => ev.meta.cwd !== "/blocked",
      debounceMs: 5,
      host: HOST,
    });
    loop.setMeta("s1", meta);
    await loop.flushNow("s1");
    assert.deepEqual(await backend.list(), []);
    assert.deepEqual(state.get(LINEAGE), {});
    loop.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
