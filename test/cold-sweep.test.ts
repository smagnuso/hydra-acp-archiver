import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ArchiveLoop } from "../src/archive-loop.js";
import { FsBackend } from "../src/backend/fs.js";
import { runColdSweep } from "../src/cold-sweep.js";
import type { DaemonClient, SessionBundle } from "../src/daemon.js";

const HOST = { host: "h", user: "u" };

function fakeBundle(sessionId: string, lineage: string): SessionBundle {
  return {
    version: 1,
    session: { sessionId, lineageId: lineage, cwd: `/work/${sessionId}` },
    history: [],
  };
}

async function startFakeDaemon(
  sessions: Array<{
    sessionId: string;
    cwd?: string;
    agentId?: string;
    title?: string;
    status: "live" | "cold";
  }>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/v1/sessions") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ sessions }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("cold sweep exports cold sessions and skips live ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-cold-"));
  const daemonStub = await startFakeDaemon([
    { sessionId: "s_live", cwd: "/w/live", status: "live" },
    { sessionId: "s_cold1", cwd: "/w/c1", status: "cold" },
    { sessionId: "s_cold2", cwd: "/w/c2", status: "cold" },
  ]);
  try {
    const backend = new FsBackend({ dir: join(dir, "backend") });
    await backend.init();
    const { SyncState } = await import("../src/state.js");
    const state = new SyncState(join(dir, "state.json"));
    await state.load();
    const exportCalls: string[] = [];
    const daemon: Partial<DaemonClient> = {
      exportSession: async (sessionId: string) => {
        exportCalls.push(sessionId);
        return fakeBundle(sessionId, `hydra_lineage_${sessionId}`);
      },
    };
    const archive = new ArchiveLoop({
      daemon: daemon as DaemonClient,
      backend,
      state,
      getRule: () => () => true,
      debounceMs: 5,
      host: HOST,
    });
    const result = await runColdSweep({
      daemonUrl: daemonStub.url,
      token: "fake",
      archive,
    });
    assert.equal(result.scanned, 3);
    assert.equal(result.cold, 2);
    assert.deepEqual(exportCalls.sort(), ["s_cold1", "s_cold2"]);
    const keys = (await backend.list()).map((e) => e.key).sort();
    assert.deepEqual(keys, [
      "hydra_lineage_s_cold1.hydra.archive",
      "hydra_lineage_s_cold2.hydra.archive",
    ]);
    archive.stop();
  } finally {
    await daemonStub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cold sweep is idempotent — second run uploads nothing new", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-cold-idem-"));
  const daemonStub = await startFakeDaemon([
    { sessionId: "s1", cwd: "/w/1", status: "cold" },
  ]);
  try {
    const backend = new FsBackend({ dir: join(dir, "backend") });
    await backend.init();
    const { SyncState } = await import("../src/state.js");
    const state = new SyncState(join(dir, "state.json"));
    await state.load();
    let puts = 0;
    const sniffBackend: typeof backend = Object.assign(
      Object.create(Object.getPrototypeOf(backend) as object),
      backend,
      {
        put: async (key: string, data: Buffer) => {
          puts += 1;
          return backend.put.call(backend, key, data);
        },
      },
    );
    const daemon: Partial<DaemonClient> = {
      exportSession: async (sessionId: string) =>
        fakeBundle(sessionId, `hydra_lineage_${sessionId}`),
    };
    const archive = new ArchiveLoop({
      daemon: daemon as DaemonClient,
      backend: sniffBackend,
      state,
      getRule: () => () => true,
      debounceMs: 5,
      host: HOST,
    });
    await runColdSweep({
      daemonUrl: daemonStub.url,
      token: "fake",
      archive,
    });
    assert.equal(puts, 1);
    await runColdSweep({
      daemonUrl: daemonStub.url,
      token: "fake",
      archive,
    });
    assert.equal(puts, 1, "second sweep should not put again — hash unchanged");
    archive.stop();
  } finally {
    await daemonStub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cold sweep respects the rule fn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-cold-rule-"));
  const daemonStub = await startFakeDaemon([
    { sessionId: "s_keep", cwd: "/work/keep", status: "cold" },
    { sessionId: "s_skip", cwd: "/tmp/scratch", status: "cold" },
  ]);
  try {
    const backend = new FsBackend({ dir: join(dir, "backend") });
    await backend.init();
    const { SyncState } = await import("../src/state.js");
    const state = new SyncState(join(dir, "state.json"));
    await state.load();
    const daemon: Partial<DaemonClient> = {
      exportSession: async (sessionId: string) =>
        fakeBundle(sessionId, `hydra_lineage_${sessionId}`),
    };
    const archive = new ArchiveLoop({
      daemon: daemon as DaemonClient,
      backend,
      state,
      getRule: () => (ev) => !ev.meta.cwd?.startsWith("/tmp/"),
      debounceMs: 5,
      host: HOST,
    });
    await runColdSweep({
      daemonUrl: daemonStub.url,
      token: "fake",
      archive,
    });
    const keys = (await backend.list()).map((e) => e.key);
    assert.deepEqual(keys, ["hydra_lineage_s_keep.hydra.archive"]);
    archive.stop();
  } finally {
    await daemonStub.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
