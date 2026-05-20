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
    await s.load();
    assert.deepEqual(s.get("anything"), {});
  } finally {
    cleanup();
  }
});

test("set persists and re-load reads back", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const a = new SyncState(path);
    await a.load();
    await a.set("lineage1", {
      lastUploadedHash: "sha256:abc",
      lastUploadedAt: "2026-05-20T00:00:00.000Z",
    });

    const b = new SyncState(path);
    await b.load();
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
    await s.load();
    await Promise.all([
      s.set("a", { lastUploadedHash: "sha256:a" }),
      s.set("b", { lastUploadedHash: "sha256:b" }),
      s.set("c", { lastUploadedHash: "sha256:c" }),
    ]);
    const reloaded = new SyncState(path);
    await reloaded.load();
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
    await s.load();
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

test("writes go through a tmp+rename so the file is never partial", async () => {
  const { path, cleanup } = tmpStatePath();
  try {
    const s = new SyncState(path);
    await s.load();
    await s.set("l", { lastUploadedHash: "sha256:1" });
    assert.equal(existsSync(`${path}.tmp`), false);
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.lineages.l.lastUploadedHash, "sha256:1");
  } finally {
    cleanup();
  }
});
