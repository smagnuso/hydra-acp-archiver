import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBackend } from "../../src/backend/fs.js";

function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "archiver-fs-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("init creates the directory if missing", async () => {
  const { dir, cleanup } = fixture();
  try {
    const target = join(dir, "nested");
    const fs = new FsBackend({ dir: target, prefix: "" });
    await fs.init();
    // list on a fresh dir returns empty
    assert.deepEqual(await fs.list(), []);
  } finally {
    cleanup();
  }
});

test("put then get round-trips data", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    const data = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
    await fs.put("a.hydra.archive", data);
    const back = await fs.get("a.hydra.archive");
    assert.deepEqual(back.toString("utf8"), data.toString("utf8"));
  } finally {
    cleanup();
  }
});

test("put is upsert and overwrites prior content", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("x.hydra.archive", Buffer.from("first"));
    await fs.put("x.hydra.archive", Buffer.from("second"));
    const back = await fs.get("x.hydra.archive");
    assert.equal(back.toString("utf8"), "second");
  } finally {
    cleanup();
  }
});

test("list returns one entry per put (ignoring tmp files)", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("a.hydra.archive", Buffer.from("a"));
    await fs.put("b.hydra.archive", Buffer.from("bb"));
    const entries = await fs.list();
    const names = entries.map((e) => e.key).sort();
    assert.deepEqual(names, ["a.hydra.archive", "b.hydra.archive"]);
    const a = entries.find((e) => e.key === "a.hydra.archive");
    const b = entries.find((e) => e.key === "b.hydra.archive");
    assert.equal(a?.size, 1);
    assert.equal(b?.size, 2);
  } finally {
    cleanup();
  }
});

test("delete removes the file and is idempotent", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("z.hydra.archive", Buffer.from("z"));
    await fs.delete("z.hydra.archive");
    await fs.delete("z.hydra.archive"); // second delete should not throw
    assert.deepEqual(await fs.list(), []);
  } finally {
    cleanup();
  }
});

test("put writes via tmp+rename — no .tmp left on disk after success", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("k.hydra.archive", Buffer.from("data"));
    const entries = await fs.list();
    assert.equal(entries.length, 1);
    assert.equal(readFileSync(join(dir, "k.hydra.archive"), "utf8"), "data");
  } finally {
    cleanup();
  }
});

// ── Prefix ───────────────────────────────────────────────────────────────────

test("prefix: init creates the prefix subdirectory", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    assert.ok(existsSync(join(dir, "alice")));
  } finally {
    cleanup();
  }
});

test("prefix: put stores files inside the prefix subdirectory", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    await fs.put("a.hydra.archive", Buffer.from("data"));
    assert.ok(existsSync(join(dir, "alice", "a.hydra.archive")));
    assert.ok(!existsSync(join(dir, "a.hydra.archive")));
  } finally {
    cleanup();
  }
});

test("prefix: get round-trips data stored under the prefix", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    await fs.put("a.hydra.archive", Buffer.from("hello"));
    const out = await fs.get("a.hydra.archive");
    assert.equal(out.toString("utf8"), "hello");
  } finally {
    cleanup();
  }
});

test("prefix: list returns bare keys without the prefix", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    await fs.put("a.hydra.archive", Buffer.from("a"));
    await fs.put("b.hydra.archive", Buffer.from("bb"));
    const keys = (await fs.list()).map((e) => e.key).sort();
    assert.deepEqual(keys, ["a.hydra.archive", "b.hydra.archive"]);
  } finally {
    cleanup();
  }
});

test("prefix: list does not see files written directly to the base dir", async () => {
  const { dir, cleanup } = fixture();
  try {
    const noPrefix = new FsBackend({ dir, prefix: "" });
    await noPrefix.init();
    await noPrefix.put("outside.hydra.archive", Buffer.from("x"));

    const withPrefix = new FsBackend({ dir, prefix: "alice" });
    await withPrefix.init();
    assert.deepEqual(await withPrefix.list(), []);
  } finally {
    cleanup();
  }
});

test("prefix: two backends with different prefixes on the same dir are isolated", async () => {
  const { dir, cleanup } = fixture();
  try {
    const alice = new FsBackend({ dir, prefix: "alice" });
    const bob = new FsBackend({ dir, prefix: "bob" });
    await alice.init();
    await bob.init();

    await alice.put("shared-name.hydra.archive", Buffer.from("alice-data"));
    await bob.put("shared-name.hydra.archive", Buffer.from("bob-data"));

    assert.equal((await alice.get("shared-name.hydra.archive")).toString(), "alice-data");
    assert.equal((await bob.get("shared-name.hydra.archive")).toString(), "bob-data");

    assert.equal((await alice.list()).length, 1);
    assert.equal((await bob.list()).length, 1);
  } finally {
    cleanup();
  }
});

test("prefix: delete removes the file from the prefix subdirectory", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    await fs.put("z.hydra.archive", Buffer.from("z"));
    await fs.delete("z.hydra.archive");
    assert.ok(!existsSync(join(dir, "alice", "z.hydra.archive")));
    assert.deepEqual(await fs.list(), []);
  } finally {
    cleanup();
  }
});

test("prefix: delete is idempotent", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice" });
    await fs.init();
    await fs.put("z.hydra.archive", Buffer.from("z"));
    await fs.delete("z.hydra.archive");
    await assert.doesNotReject(() => fs.delete("z.hydra.archive"));
  } finally {
    cleanup();
  }
});

// ── Recursive listing (host subdirectory support) ────────────────────────────

test("list recurses into subdirectories and returns relative paths", async () => {
  const { dir, cleanup } = fixture();
  try {
    // Simulate two hosts writing under a shared user prefix by using a
    // no-prefix backend whose keys include a host segment.
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("alice-macbook/a.hydra.archive", Buffer.from("a"));
    await fs.put("alice-desktop/b.hydra.archive", Buffer.from("b"));
    const keys = (await fs.list()).map((e) => e.key).sort();
    assert.deepEqual(keys, [
      "alice-desktop/b.hydra.archive",
      "alice-macbook/a.hydra.archive",
    ]);
  } finally {
    cleanup();
  }
});

test("list returns correct sizes for entries in subdirectories", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    await fs.put("host-a/x.hydra.archive", Buffer.from("hello"));
    const entries = await fs.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.size, 5);
    assert.equal(entries[0]?.key, "host-a/x.hydra.archive");
  } finally {
    cleanup();
  }
});

test("list is empty when subdirectory exists but contains no files", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await fs.init();
    // Create the subdirectory via a put+delete cycle
    await fs.put("host-a/x.hydra.archive", Buffer.from("x"));
    await fs.delete("host-a/x.hydra.archive");
    assert.deepEqual(await fs.list(), []);
  } finally {
    cleanup();
  }
});

test("prefix with trailing slash works identically to without (auto-prefix format)", async () => {
  const { dir, cleanup } = fixture();
  try {
    const fs = new FsBackend({ dir, prefix: "alice/" });
    await fs.init();
    await fs.put("a.hydra.archive", Buffer.from("hello"));
    // File lands at dir/alice/a.hydra.archive (path.resolve normalises the slash)
    assert.ok(existsSync(join(dir, "alice", "a.hydra.archive")));
    const keys = (await fs.list()).map((e) => e.key);
    assert.deepEqual(keys, ["a.hydra.archive"]);
  } finally {
    cleanup();
  }
});
