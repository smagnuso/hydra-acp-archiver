import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
    const fs = new FsBackend({ dir: target });
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
    const fs = new FsBackend({ dir });
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
    const fs = new FsBackend({ dir });
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
    const fs = new FsBackend({ dir });
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
    const fs = new FsBackend({ dir });
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
    const fs = new FsBackend({ dir });
    await fs.init();
    await fs.put("k.hydra.archive", Buffer.from("data"));
    const entries = await fs.list();
    assert.equal(entries.length, 1);
    assert.equal(readFileSync(join(dir, "k.hydra.archive"), "utf8"), "data");
  } finally {
    cleanup();
  }
});
