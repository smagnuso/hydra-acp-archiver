import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "../src/backend/fs.js";
import {
  hashBundle,
  keyFor,
  serialize,
  wrap,
  type SyncEnvelope,
} from "../src/envelope.js";
import { PullLoop } from "../src/pull-loop.js";
import { SyncState } from "../src/state.js";
import type { DaemonClient, SessionBundle } from "../src/daemon.js";

const LINEAGE = "hydra_lineage_pull_test_0001";
const SELF_HOST = "this-host";
const REMOTE_HOST = "other-host";

function bundle(history: unknown[] = []): SessionBundle {
  return {
    version: 1,
    session: { sessionId: "s1", lineageId: LINEAGE, cwd: "/tmp/x" },
    history,
  };
}

function envelopeFor(
  b: SessionBundle,
  host: string,
  uploadedAt: string,
): SyncEnvelope {
  return wrap(b, LINEAGE, { host, user: "u" }, new Date(uploadedAt));
}

interface Fixture {
  pull: PullLoop;
  backend: FsBackend;
  state: SyncState;
  imports: SessionBundle[];
  cleanup: () => void;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "archiver-pull-"));
  const backend = new FsBackend({ dir: join(dir, "backend") });
  const state = new SyncState(join(dir, "state.json"));
  const imports: SessionBundle[] = [];
  const daemon: Partial<DaemonClient> = {
    importBundle: async (b: SessionBundle) => {
      imports.push(b);
      return { sessionId: b.session.sessionId };
    },
  };
  const pull = new PullLoop({
    daemon: daemon as DaemonClient,
    backend,
    state,
    intervalMs: 60_000,
    host: SELF_HOST,
  });
  return {
    pull,
    backend,
    state,
    imports,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("imports a fresh remote envelope and updates state", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load();
    const env = envelopeFor(
      bundle([{ role: "assistant", text: "remote turn" }]),
      REMOTE_HOST,
      "2026-05-20T10:00:00.000Z",
    );
    await f.backend.put(keyFor(LINEAGE), serialize(env));

    await f.pull.tickNow();

    assert.equal(f.imports.length, 1);
    assert.equal(f.imports[0]?.session.lineageId, LINEAGE);
    const s = f.state.get(LINEAGE);
    assert.equal(s.lastSeenRemoteUploadedAt, env.uploadedAt);
    assert.equal(s.lastSeenRemoteBy, REMOTE_HOST);
    assert.equal(s.lastUploadedHash, env.bundleHash);
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});

test("does not re-import an envelope older than lastSeenRemoteUploadedAt", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load();
    await f.state.set(LINEAGE, {
      lastSeenRemoteUploadedAt: "2026-05-20T12:00:00.000Z",
      lastSeenRemoteBy: REMOTE_HOST,
    });
    const env = envelopeFor(
      bundle(),
      REMOTE_HOST,
      "2026-05-20T10:00:00.000Z",
    );
    await f.backend.put(keyFor(LINEAGE), serialize(env));

    await f.pull.tickNow();

    assert.equal(f.imports.length, 0);
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});

test("self-loop suppression: own host + matching hash is skipped", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load();
    const b = bundle();
    const env = envelopeFor(b, SELF_HOST, "2026-05-20T10:00:00.000Z");
    await f.state.set(LINEAGE, {
      lastUploadedHash: hashBundle(b),
      lastUploadedAt: env.uploadedAt,
    });
    await f.backend.put(keyFor(LINEAGE), serialize(env));

    await f.pull.tickNow();

    assert.equal(f.imports.length, 0);
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});

test("newer remote envelope re-imports even when state has an older lastSeenRemoteUploadedAt", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load();
    await f.state.set(LINEAGE, {
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: REMOTE_HOST,
    });
    const env = envelopeFor(
      bundle([{ x: 1 }]),
      REMOTE_HOST,
      "2026-05-20T11:00:00.000Z",
    );
    await f.backend.put(keyFor(LINEAGE), serialize(env));

    await f.pull.tickNow();

    assert.equal(f.imports.length, 1);
    assert.equal(f.state.get(LINEAGE).lastSeenRemoteUploadedAt, env.uploadedAt);
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});

test("malformed envelope is skipped without throwing", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load();
    await f.backend.put(
      keyFor(LINEAGE),
      Buffer.from("not valid json", "utf8"),
    );

    await f.pull.tickNow();

    assert.equal(f.imports.length, 0);
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});
