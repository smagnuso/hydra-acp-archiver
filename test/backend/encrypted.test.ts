import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EncryptedBackend } from "../../src/backend/encrypted.js";
import { FsBackend } from "../../src/backend/fs.js";
import type { SyncBackend, SyncBackendEntry } from "../../src/backend/types.js";

// Minimal in-memory backend — no FS needed to test encryption logic.
class MemBackend implements SyncBackend {
  readonly store = new Map<string, Buffer>();

  async init(): Promise<void> {}

  async list(): Promise<SyncBackendEntry[]> {
    return [...this.store.entries()].map(([key, data]) => ({
      key,
      size: data.length,
      modifiedAt: new Date(0).toISOString(),
    }));
  }

  async get(key: string): Promise<Buffer> {
    const data = this.store.get(key);
    if (data === undefined)
      throw new Error(`MemBackend: no key "${key}"`);
    return data;
  }

  async put(key: string, data: Buffer): Promise<void> {
    this.store.set(key, data);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function key32(): Buffer {
  return randomBytes(32);
}

function enc(inner: MemBackend, key: Buffer = key32()): EncryptedBackend {
  return new EncryptedBackend(inner, key);
}

// ── Constructor ──────────────────────────────────────────────────────────────

test("constructor throws when key is shorter than 32 bytes", () => {
  assert.throws(
    () => enc(new MemBackend(), randomBytes(16)),
    /encryption key must be 32 bytes/,
  );
});

test("constructor throws when key is longer than 32 bytes", () => {
  assert.throws(
    () => enc(new MemBackend(), randomBytes(64)),
    /encryption key must be 32 bytes/,
  );
});

test("constructor accepts exactly 32 bytes", () => {
  assert.doesNotThrow(() => enc(new MemBackend(), randomBytes(32)));
});

// ── Round-trip ───────────────────────────────────────────────────────────────

test("put then get round-trips arbitrary data", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  const plaintext = Buffer.from(JSON.stringify({ hello: "world" }), "utf8");
  await backend.put("a.hydra.archive", plaintext);
  const out = await backend.get("a.hydra.archive");
  assert.deepEqual(out, plaintext);
});

test("round-trip empty buffer", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("empty.hydra.archive", Buffer.alloc(0));
  const out = await backend.get("empty.hydra.archive");
  assert.equal(out.length, 0);
});

test("round-trip large buffer (1 MB)", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  const plaintext = randomBytes(1024 * 1024);
  await backend.put("big.hydra.archive", plaintext);
  const out = await backend.get("big.hydra.archive");
  assert.deepEqual(out, plaintext);
});

test("put is upsert — second put overwrites and get reads latest", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("x.hydra.archive", Buffer.from("first"));
  await backend.put("x.hydra.archive", Buffer.from("second"));
  const out = await backend.get("x.hydra.archive");
  assert.equal(out.toString("utf8"), "second");
});

// ── Wire format ──────────────────────────────────────────────────────────────

test("stored blob is not the plaintext", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  const plaintext = Buffer.from("do not store me raw");
  await backend.put("f.hydra.archive", plaintext);
  const raw = inner.store.get("f.hydra.archive")!;
  assert.ok(!raw.includes(plaintext));
});

test("wire format: total length is plaintext + 37 bytes overhead", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  const plaintext = randomBytes(100);
  await backend.put("w.hydra.archive", plaintext);
  const raw = inner.store.get("w.hydra.archive")!;
  // 1 version + 8 fingerprint + 12 IV + 100 ciphertext + 16 tag
  assert.equal(raw.length, 100 + 1 + 8 + 12 + 16);
});

test("wire format: empty plaintext produces exactly 37 bytes", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("e.hydra.archive", Buffer.alloc(0));
  const raw = inner.store.get("e.hydra.archive")!;
  assert.equal(raw.length, 37);
});

test("wire format: first byte is version 1", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("v.hydra.archive", Buffer.from("x"));
  const raw = inner.store.get("v.hydra.archive")!;
  assert.equal(raw[0], 1);
});

test("wire format: bytes 1–8 are SHA-256(key)[0:8]", async () => {
  const inner = new MemBackend();
  const key = key32();
  const backend = new EncryptedBackend(inner, key);
  await backend.put("fp.hydra.archive", Buffer.from("x"));
  const raw = inner.store.get("fp.hydra.archive")!;
  const expectedFingerprint = createHash("sha256").update(key).digest().subarray(0, 8);
  assert.deepEqual(raw.subarray(1, 9), expectedFingerprint);
});

test("fingerprint is identical for two instances sharing the same key", async () => {
  const key = key32();
  const inner1 = new MemBackend();
  const inner2 = new MemBackend();
  const b1 = new EncryptedBackend(inner1, key);
  const b2 = new EncryptedBackend(inner2, key);
  await b1.put("k.hydra.archive", Buffer.from("a"));
  await b2.put("k.hydra.archive", Buffer.from("a"));
  // fingerprint lives at bytes 1–8 (after the 1-byte version)
  const fp1 = inner1.store.get("k.hydra.archive")!.subarray(1, 9);
  const fp2 = inner2.store.get("k.hydra.archive")!.subarray(1, 9);
  assert.deepEqual(fp1, fp2);
});

test("two puts of the same plaintext produce different ciphertext (fresh IV each time)", async () => {
  const inner = new MemBackend();
  const key = key32();
  const backend = new EncryptedBackend(inner, key);
  const plaintext = Buffer.from("same content");
  await backend.put("k1.hydra.archive", plaintext);
  const blob1 = Buffer.from(inner.store.get("k1.hydra.archive")!);
  await backend.put("k2.hydra.archive", plaintext);
  const blob2 = Buffer.from(inner.store.get("k2.hydra.archive")!);
  // IVs live at bytes 9–21; ciphertext starts at 21
  assert.notDeepEqual(blob1.subarray(9, 21), blob2.subarray(9, 21));
  assert.notDeepEqual(blob1.subarray(21), blob2.subarray(21));
});

// ── Key mismatch detection ────────────────────────────────────────────────────

test("get with a different key throws 'key mismatch'", async () => {
  const inner = new MemBackend();
  const writerKey = key32();
  const readerKey = key32();
  const writer = new EncryptedBackend(inner, writerKey);
  const reader = new EncryptedBackend(inner, readerKey);
  await writer.put("m.hydra.archive", Buffer.from("secret"));
  await assert.rejects(
    () => reader.get("m.hydra.archive"),
    /key mismatch/,
  );
});

test("key mismatch error names the key", async () => {
  const inner = new MemBackend();
  await new EncryptedBackend(inner, key32()).put("named.hydra.archive", Buffer.from("x"));
  await assert.rejects(
    () => new EncryptedBackend(inner, key32()).get("named.hydra.archive"),
    /named\.hydra\.archive/,
  );
});

test("tampering with the fingerprint bytes throws key mismatch", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("t.hydra.archive", Buffer.from("tamper me"));
  const raw = Buffer.from(inner.store.get("t.hydra.archive")!);
  raw[1] ^= 0xff; // flip bits in the fingerprint (byte 1, after version)
  inner.store.set("t.hydra.archive", raw);
  await assert.rejects(
    () => backend.get("t.hydra.archive"),
    /key mismatch/,
  );
});

test("unknown version byte throws a clear version error", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("ver.hydra.archive", Buffer.from("data"));
  const raw = Buffer.from(inner.store.get("ver.hydra.archive")!);
  raw[0] = 99; // unsupported version
  inner.store.set("ver.hydra.archive", raw);
  await assert.rejects(
    () => backend.get("ver.hydra.archive"),
    /unsupported encryption version 99/,
  );
});

// ── Corruption detection ─────────────────────────────────────────────────────

test("tampering with ciphertext bytes throws authentication error", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("c.hydra.archive", Buffer.from("tamper the ciphertext"));
  const raw = Buffer.from(inner.store.get("c.hydra.archive")!);
  // ciphertext starts at byte 20 (8 fp + 12 iv), ends before last 16 (tag)
  raw[20] ^= 0xff;
  inner.store.set("c.hydra.archive", raw);
  await assert.rejects(
    () => backend.get("c.hydra.archive"),
    /failed authentication|corrupted/,
  );
});

test("tampering with the GCM auth tag throws authentication error", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("tag.hydra.archive", Buffer.from("tamper the tag"));
  const raw = Buffer.from(inner.store.get("tag.hydra.archive")!);
  raw[raw.length - 1] ^= 0xff; // flip last byte of tag
  inner.store.set("tag.hydra.archive", raw);
  await assert.rejects(
    () => backend.get("tag.hydra.archive"),
    /failed authentication|corrupted/,
  );
});

test("tampering with IV bytes throws authentication error", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("iv.hydra.archive", Buffer.from("tamper the iv"));
  const raw = Buffer.from(inner.store.get("iv.hydra.archive")!);
  // IV lives at bytes 8–20
  raw[10] ^= 0xff;
  inner.store.set("iv.hydra.archive", raw);
  await assert.rejects(
    () => backend.get("iv.hydra.archive"),
    /failed authentication|corrupted/,
  );
});

test("blob shorter than minimum 37 bytes throws 'too short'", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  inner.store.set("short.hydra.archive", Buffer.alloc(36));
  await assert.rejects(
    () => backend.get("short.hydra.archive"),
    /too short/,
  );
});

test("blob of exactly 36 bytes (one under minimum) throws 'too short'", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  inner.store.set("s.hydra.archive", randomBytes(36));
  await assert.rejects(
    () => backend.get("s.hydra.archive"),
    /too short/,
  );
});

// ── Delegation: init / list / delete ─────────────────────────────────────────

test("init delegates to inner backend", async () => {
  let called = false;
  const inner = new MemBackend();
  inner.init = async () => { called = true; };
  await enc(inner).init();
  assert.ok(called);
});

test("list delegates to inner backend and returns its entries", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("a.hydra.archive", Buffer.from("aaa"));
  await backend.put("b.hydra.archive", Buffer.from("bb"));
  const entries = await backend.list();
  const keys = entries.map((e) => e.key).sort();
  assert.deepEqual(keys, ["a.hydra.archive", "b.hydra.archive"]);
});

test("list sizes reflect encrypted blob length, not plaintext length", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  const plaintext = Buffer.from("hello"); // 5 bytes
  await backend.put("sz.hydra.archive", plaintext);
  const entries = await backend.list();
  const entry = entries.find((e) => e.key === "sz.hydra.archive");
  // encrypted overhead is always 37 bytes (1 version + 8 fp + 12 IV + 16 tag)
  assert.equal(entry?.size, plaintext.length + 37);
});

test("delete delegates to inner backend and removes the blob", async () => {
  const inner = new MemBackend();
  const backend = enc(inner);
  await backend.put("d.hydra.archive", Buffer.from("delete me"));
  await backend.delete("d.hydra.archive");
  assert.equal(inner.store.size, 0);
});

test("delete is idempotent via inner backend", async () => {
  const inner = new MemBackend();
  // override delete to be idempotent
  inner.delete = async () => {};
  const backend = enc(inner);
  await assert.doesNotReject(() => backend.delete("gone.hydra.archive"));
});

// ── Cross-instance compatibility ──────────────────────────────────────────────

test("blob written by one instance is readable by another instance with the same key", async () => {
  const inner = new MemBackend();
  const key = key32();
  const writer = new EncryptedBackend(inner, key);
  const reader = new EncryptedBackend(inner, key);
  const plaintext = Buffer.from("cross-instance round-trip");
  await writer.put("cross.hydra.archive", plaintext);
  const out = await reader.get("cross.hydra.archive");
  assert.deepEqual(out, plaintext);
});

// ── Integration: EncryptedBackend over FsBackend ─────────────────────────────

test("integration: put+get round-trips through a real FsBackend", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-enc-fs-"));
  try {
    const key = key32();
    const backend = new EncryptedBackend(new FsBackend({ dir, prefix: "" }), key);
    await backend.init();
    const plaintext = Buffer.from(JSON.stringify({ session: "abc", turn: 42 }));
    await backend.put("abc.hydra.archive", plaintext);
    const out = await backend.get("abc.hydra.archive");
    assert.deepEqual(out, plaintext);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: file on disk is not the plaintext", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-enc-fs-"));
  try {
    const key = key32();
    const backend = new EncryptedBackend(new FsBackend({ dir, prefix: "" }), key);
    await backend.init();
    const plaintext = Buffer.from("do not store me raw");
    await backend.put("p.hydra.archive", plaintext);
    const raw = await new FsBackend({ dir, prefix: "" }).get("p.hydra.archive");
    assert.ok(!raw.includes(plaintext));
    assert.equal(raw.length, plaintext.length + 37);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: list returns bare keys and encrypted sizes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-enc-fs-"));
  try {
    const key = key32();
    const backend = new EncryptedBackend(new FsBackend({ dir, prefix: "" }), key);
    await backend.init();
    await backend.put("a.hydra.archive", Buffer.from("aa"));
    await backend.put("b.hydra.archive", Buffer.from("bbb"));
    const entries = await backend.list();
    const keys = entries.map((e) => e.key).sort();
    assert.deepEqual(keys, ["a.hydra.archive", "b.hydra.archive"]);
    const a = entries.find((e) => e.key === "a.hydra.archive");
    assert.equal(a?.size, 2 + 37);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("integration: wrong key on read throws key mismatch (not a file error)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-enc-fs-"));
  try {
    const fs = new FsBackend({ dir, prefix: "" });
    await new EncryptedBackend(fs, key32()).init();
    await new EncryptedBackend(fs, key32()).put("x.hydra.archive", Buffer.from("secret"));
    await assert.rejects(
      () => new EncryptedBackend(fs, key32()).get("x.hydra.archive"),
      /key mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multiple keys each decrypt only their own blobs", async () => {
  const inner = new MemBackend();
  const keyA = key32();
  const keyB = key32();
  const backendA = new EncryptedBackend(inner, keyA);
  const backendB = new EncryptedBackend(inner, keyB);

  await backendA.put("a.hydra.archive", Buffer.from("owned by A"));
  await backendB.put("b.hydra.archive", Buffer.from("owned by B"));

  assert.deepEqual((await backendA.get("a.hydra.archive")).toString(), "owned by A");
  assert.deepEqual((await backendB.get("b.hydra.archive")).toString(), "owned by B");

  await assert.rejects(() => backendA.get("b.hydra.archive"), /key mismatch/);
  await assert.rejects(() => backendB.get("a.hydra.archive"), /key mismatch/);
});
