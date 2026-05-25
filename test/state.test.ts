import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncState } from "../src/state.js";

function tmpStatePath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "archiver-state-"));
  return {
    path: join(dir, "state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("load creates empty state when file missing", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    assert.deepEqual(s.get("anything"), {});
  } finally {
    cleanup();
  }
});

test("set persists and re-load reads back", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const a = new SyncState(path);
    await a.load("0.0.0", "", "fs");
    await a.set("lineage1", {
      lastUploadedHash: "sha256:abc",
      lastUploadedAt: "2026-05-20T00:00:00.000Z",
    });

    const b = new SyncState(path);
    await b.load("0.0.0", "", "fs");
    assert.deepEqual(b.get("lineage1"), {
      lastUploadedHash: "sha256:abc",
      lastUploadedAt: "2026-05-20T00:00:00.000Z",
    });
  } finally {
    cleanup();
  }
});

test("concurrent set calls are serialized without losing data", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    await Promise.all([
      s.set("a", { lastUploadedHash: "sha256:a" }),
      s.set("b", { lastUploadedHash: "sha256:b" }),
      s.set("c", { lastUploadedHash: "sha256:c" }),
    ]);
    const reloaded = new SyncState(path);
    await reloaded.load("0.0.0", "", "fs");
    assert.equal(reloaded.get("a").lastUploadedHash, "sha256:a");
    assert.equal(reloaded.get("b").lastUploadedHash, "sha256:b");
    assert.equal(reloaded.get("c").lastUploadedHash, "sha256:c");
  } finally {
    cleanup();
  }
});

test("set merges keys rather than replacing the lineage record", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    await s.set("l", { lastUploadedHash: "sha256:1" });
    await s.set("l", { lastSeenRemoteUploadedAt: "2026-05-20T00:00:00.000Z" });
    assert.deepEqual(s.get("l"), {
      lastUploadedHash: "sha256:1",
      lastSeenRemoteUploadedAt: "2026-05-20T00:00:00.000Z",
    });
  } finally {
    cleanup();
  }
});

test("reconcile prunes lineages absent from the backend snapshot", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    await s.set("present_a", { lastUploadedHash: "sha256:a" });
    await s.set("present_b", { lastUploadedHash: "sha256:b" });
    await s.set("gone", { lastUploadedHash: "sha256:gone" });
    const pruned = await s.reconcile(new Set(["present_a", "present_b"]));
    assert.equal(pruned, 1);
    assert.deepEqual(s.get("present_a"), { lastUploadedHash: "sha256:a" });
    assert.deepEqual(s.get("present_b"), { lastUploadedHash: "sha256:b" });
    assert.deepEqual(s.get("gone"), {});

    const reloaded = new SyncState(path);
    await reloaded.load("0.0.0", "", "fs");
    assert.deepEqual(reloaded.get("gone"), {});
    assert.equal(reloaded.get("present_a").lastUploadedHash, "sha256:a");
  } finally {
    cleanup();
  }
});

test("reconcile is a no-op when nothing needs pruning", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    await s.set("l", { lastUploadedHash: "sha256:1" });
    const pruned = await s.reconcile(new Set(["l"]));
    assert.equal(pruned, 0);
    assert.equal(s.get("l").lastUploadedHash, "sha256:1");
  } finally {
    cleanup();
  }
});

test("writes go through a tmp+rename so the file is never partial", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "", "fs");
    await s.set("l", { lastUploadedHash: "sha256:1" });
    assert.equal(existsSync(`${path}.tmp`), false);
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.appVersion, "0.0.0");
    assert.equal(parsed.lineages.l.lastUploadedHash, "sha256:1");
  } finally {
    cleanup();
  }
});

test("prefix change clears lastSeenRemoteUploadedAt but preserves upload hashes", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "prefix-a/", "fs");
    await s.set("l1", {
      lastUploadedHash: "sha256:abc",
      lastUploadedAt: "2026-05-20T10:00:00.000Z",
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: "other-host",
    });

    // Reload with a different prefix — pull state should be wiped, upload state kept
    const s2 = new SyncState(path);
    await s2.load("0.0.0", "prefix-b/", "fs");
    const entry = s2.get("l1");
    assert.equal(entry.lastSeenRemoteUploadedAt, undefined);
    assert.equal(entry.lastSeenRemoteBy, undefined);
    assert.equal(entry.lastUploadedHash, "sha256:abc");
    assert.equal(entry.lastUploadedAt, "2026-05-20T10:00:00.000Z");
  } finally {
    cleanup();
  }
});

test("same prefix on reload preserves all state including pull timestamps", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "prefix-a/", "fs");
    await s.set("l1", {
      lastUploadedHash: "sha256:abc",
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: "other-host",
    });

    const s2 = new SyncState(path);
    await s2.load("0.0.0", "prefix-a/", "fs");
    const entry = s2.get("l1");
    assert.equal(entry.lastSeenRemoteUploadedAt, "2026-05-20T09:00:00.000Z");
    assert.equal(entry.lastSeenRemoteBy, "other-host");
    assert.equal(entry.lastUploadedHash, "sha256:abc");
  } finally {
    cleanup();
  }
});

test("backend change clears lastSeenRemoteUploadedAt but preserves upload hashes", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.0.0", "prefix/", "google-drive");
    await s.set("l1", {
      lastUploadedHash: "sha256:abc",
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: "other-host",
    });

    const s2 = new SyncState(path);
    await s2.load("0.0.0", "prefix/", "s3");
    const entry = s2.get("l1");
    assert.equal(entry.lastSeenRemoteUploadedAt, undefined);
    assert.equal(entry.lastSeenRemoteBy, undefined);
    assert.equal(entry.lastUploadedHash, "sha256:abc");
  } finally {
    cleanup();
  }
});

test("app version change clears pull state but preserves upload hashes", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load("0.1.10", "prefix/", "google-drive");
    await s.set("l1", {
      lastUploadedHash: "sha256:abc",
      lastSeenRemoteUploadedAt: "2026-05-20T09:00:00.000Z",
      lastSeenRemoteBy: "other-host",
      importedSessionId: "s_peer",
    });

    const s2 = new SyncState(path);
    await s2.load("0.1.11", "prefix/", "google-drive");
    const entry = s2.get("l1");
    assert.equal(entry.lastSeenRemoteUploadedAt, undefined);
    assert.equal(entry.lastSeenRemoteBy, undefined);
    assert.equal(entry.importedSessionId, undefined);
    assert.equal(entry.lastUploadedHash, "sha256:abc");
  } finally {
    cleanup();
  }
});
