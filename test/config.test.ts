import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEncryptionKey, loadConfig } from "../src/config.js";

// Run loadConfig() with a clean env + temp HYDRA_ACP_HOME, restoring env.
function withConfigEnv<T>(
  env: Record<string, string | undefined>,
  conf: string | undefined,
  fn: () => T,
): T {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-"));
  if (conf !== undefined) {
    writeFileSync(join(dir, "archiver.conf"), conf);
  }
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string | undefined) => {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  // Clear conf-overriding envs so the conf file (or default) wins.
  set("HYDRA_ACP_ARCHIVER_TOOL_CONTENT", undefined);
  set("HYDRA_ACP_HOME", dir);
  set("HYDRA_ACP_TOKEN", "t");
  set("HYDRA_ACP_ARCHIVER_CONF", join(dir, "archiver.conf"));
  for (const [k, v] of Object.entries(env)) set(k, v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("loadConfig: toolContent defaults to inline", () => {
  const c = withConfigEnv({}, undefined, () => loadConfig());
  assert.equal(c.toolContent, "inline");
});

test("loadConfig: toolContent honors TOOL_CONTENT from conf (references/summary)", () => {
  assert.equal(
    withConfigEnv({}, "TOOL_CONTENT=references\n", () => loadConfig()).toolContent,
    "references",
  );
  assert.equal(
    withConfigEnv({}, "TOOL_CONTENT=summary\n", () => loadConfig()).toolContent,
    "summary",
  );
});

test("loadConfig: invalid TOOL_CONTENT falls back to inline", () => {
  assert.equal(
    withConfigEnv({}, "TOOL_CONTENT=bogus\n", () => loadConfig()).toolContent,
    "inline",
  );
});

function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "archiver-config-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeKey(dir: string, content: string, name = "archiver-key"): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

// ── undefined path ───────────────────────────────────────────────────────────

test("loadEncryptionKey: returns undefined when path is undefined", async () => {
  const result = await loadEncryptionKey(undefined);
  assert.equal(result, undefined);
});

// ── valid key files ──────────────────────────────────────────────────────────

test("loadEncryptionKey: returns a 32-byte Buffer from a valid hex file", async () => {
  const { dir, cleanup } = fixture();
  try {
    const hex = "a".repeat(64);
    const p = writeKey(dir, hex);
    const key = await loadEncryptionKey(p);
    assert.ok(Buffer.isBuffer(key));
    assert.equal(key!.length, 32);
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: decoded bytes match the hex content", async () => {
  const { dir, cleanup } = fixture();
  try {
    const hex = "deadbeef".repeat(8); // 64 hex chars = 32 bytes
    const p = writeKey(dir, hex);
    const key = await loadEncryptionKey(p);
    assert.deepEqual(key, Buffer.from(hex, "hex"));
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: trims a trailing newline (keygen writes one)", async () => {
  const { dir, cleanup } = fixture();
  try {
    const hex = "b".repeat(64);
    const p = writeKey(dir, hex + "\n");
    const key = await loadEncryptionKey(p);
    assert.equal(key!.length, 32);
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: accepts uppercase hex", async () => {
  const { dir, cleanup } = fixture();
  try {
    const hex = "DEADBEEF".repeat(8);
    const p = writeKey(dir, hex);
    const key = await loadEncryptionKey(p);
    assert.deepEqual(key, Buffer.from(hex, "hex"));
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: accepts mixed-case hex", async () => {
  const { dir, cleanup } = fixture();
  try {
    const hex = "DeAdBeEf".repeat(8);
    const p = writeKey(dir, hex);
    const key = await loadEncryptionKey(p);
    assert.deepEqual(key, Buffer.from(hex, "hex"));
  } finally {
    cleanup();
  }
});

// ── missing file ─────────────────────────────────────────────────────────────

test("loadEncryptionKey: throws when key file does not exist", async () => {
  await assert.rejects(
    () => loadEncryptionKey("/nonexistent/path/archiver-key"),
    /Encryption key file not found/,
  );
});

test("loadEncryptionKey: missing-file error includes the path", async () => {
  const p = "/no/such/file";
  await assert.rejects(
    () => loadEncryptionKey(p),
    new RegExp(p.replace("/", "\\/")),
  );
});

test("loadEncryptionKey: missing-file error mentions keygen", async () => {
  await assert.rejects(
    () => loadEncryptionKey("/no/such/file"),
    /keygen/,
  );
});

// ── invalid content ──────────────────────────────────────────────────────────

test("loadEncryptionKey: throws on non-hex characters", async () => {
  const { dir, cleanup } = fixture();
  try {
    const p = writeKey(dir, "z".repeat(64));
    await assert.rejects(
      () => loadEncryptionKey(p),
      /not a valid 64-character hex string/,
    );
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: throws when hex string is too short (32 chars)", async () => {
  const { dir, cleanup } = fixture();
  try {
    const p = writeKey(dir, "a".repeat(32));
    await assert.rejects(
      () => loadEncryptionKey(p),
      /not a valid 64-character hex string/,
    );
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: throws when hex string is too long (128 chars)", async () => {
  const { dir, cleanup } = fixture();
  try {
    const p = writeKey(dir, "a".repeat(128));
    await assert.rejects(
      () => loadEncryptionKey(p),
      /not a valid 64-character hex string/,
    );
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: throws on empty file", async () => {
  const { dir, cleanup } = fixture();
  try {
    const p = writeKey(dir, "");
    await assert.rejects(
      () => loadEncryptionKey(p),
      /not a valid 64-character hex string/,
    );
  } finally {
    cleanup();
  }
});

test("loadEncryptionKey: invalid-content error includes the path", async () => {
  const { dir, cleanup } = fixture();
  try {
    const p = writeKey(dir, "bad content");
    await assert.rejects(
      () => loadEncryptionKey(p),
      new RegExp(dir.replace("/", "\\/")),
    );
  } finally {
    cleanup();
  }
});
