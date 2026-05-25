import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "../src/backend/fs.js";
import {
  keyFor,
  serialize,
  wrap,
  type SyncEnvelope,
} from "../src/envelope.js";
import { PullLoop } from "../src/pull-loop.js";
import { SyncState } from "../src/state.js";
import type { DaemonClient, SessionBundle } from "../src/daemon.js";

const LINEAGE = "hydra_lineage_pull_test_0001";
const REMOTE_HOST = "other-host";

function bundle(sessionId: string, history: unknown[] = []): SessionBundle {
  return {
    version: 1,
    session: { sessionId, lineageId: LINEAGE, cwd: "/tmp/x" },
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
  localSessionIds: Set<string>;
  cleanup: () => void;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "archiver-pull-"));
  const backend = new FsBackend({ dir: join(dir, "backend"), prefix: "" });
  const state = new SyncState(join(dir, "state.json"));
  const imports: SessionBundle[] = [];
  const localSessionIds = new Set<string>();
  const daemon: Partial<DaemonClient> = {
    listSessionIds: async () => new Set(localSessionIds),
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
    hostId: "local-host",
  });
  return {
    pull,
    backend,
    state,
    imports,
    localSessionIds,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("imports a fresh remote envelope and updates state", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load("", "fs");
    const env = envelopeFor(
      bundle("s_remote", [{ role: "assistant", text: "remote turn" }]),
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
    await f.state.load("", "fs");
    await f.state.set(LINEAGE, {
      lastSeenRemoteUploadedAt: "2026-05-20T12:00:00.000Z",
      lastSeenRemoteBy: REMOTE_HOST,
    });
    const env = envelopeFor(
      bundle("s_remote"),
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

test("self-loop suppression: envelope whose sessionId is local is skipped", async () => {
  // The signal that catches "our own upload echoing back": the bundle's
  // inner sessionId is already in the daemon's session list. Survives
  // hostname changes and racing state writes (the previous hostname/
  // hash-based check did not — that's what caused duplicate sessions
  // during the cold sweep).
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load("", "fs");
    f.localSessionIds.add("s_local");
    const env = envelopeFor(
      bundle("s_local"),
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

test("envelope with unknown sessionId is imported even when lineage is known", async () => {
  // Cross-machine update: a peer imported our upload (getting a new
  // sessionId), worked on it, and uploaded back. Lineage matches but
  // sessionId doesn't — we must not skip this.
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load("", "fs");
    f.localSessionIds.add("s_local");
    await f.state.set(LINEAGE, {
      lastUploadedHash: "sha256:older",
      lastUploadedAt: "2026-05-20T09:00:00.000Z",
    });
    const env = envelopeFor(
      bundle("s_peer", [{ x: 1 }]),
      REMOTE_HOST,
      "2026-05-20T11:00:00.000Z",
    );
    await f.backend.put(keyFor(LINEAGE), serialize(env));

    await f.pull.tickNow();

    assert.equal(f.imports.length, 1);
    assert.equal(f.imports[0]?.session.sessionId, "s_peer");
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});

test("newer remote envelope re-imports even when state has an older lastSeenRemoteUploadedAt", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load("", "fs");
    await f.state.set(LINEAGE, {
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: REMOTE_HOST,
    });
    const env = envelopeFor(
      bundle("s_remote_2", [{ x: 1 }]),
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
    await f.state.load("", "fs");
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

test("own-host entries are skipped without being imported", async () => {
  const f = setup();
  try {
    await f.backend.init();
    await f.state.load("", "fs");

    const PEER_LINEAGE = "hydra_lineage_peer_0001";
    const ownKey = `local-host/${keyFor(LINEAGE)}`;
    const peerKey = `peer-host/${keyFor(PEER_LINEAGE)}`;

    const ownEnvelope = envelopeFor(bundle("own-session"), REMOTE_HOST, "2026-05-20T10:00:00.000Z");
    const peerBundle: SessionBundle = {
      version: 1,
      session: { sessionId: "peer-session", lineageId: PEER_LINEAGE, cwd: "/tmp/p" },
      history: [],
    };
    const peerEnvelope = wrap(peerBundle, PEER_LINEAGE, { host: "peer-host", user: "u" }, new Date("2026-05-20T10:00:00.000Z"));

    await f.backend.put(ownKey, Buffer.from(serialize(ownEnvelope)));
    await f.backend.put(peerKey, Buffer.from(serialize(peerEnvelope)));

    await f.pull.tickNow();

    // Only the peer envelope should have been imported.
    assert.equal(f.imports.length, 1);
    assert.equal(
      (f.imports[0] as { session?: { sessionId?: string } }).session?.sessionId,
      "peer-session",
    );
  } finally {
    f.pull.stop();
    f.cleanup();
  }
});
