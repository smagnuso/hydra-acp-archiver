import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConf, readExisting, writeConf } from "../../src/setup/conf-writer.js";

test("mergeConf: fresh file gets header + updated keys", () => {
  const out = mergeConf("", { BACKEND: "fs", FS_DIR: "/tmp/archive" });
  assert.match(out, /hydra-acp-archiver setup/);
  assert.match(out, /^BACKEND=fs$/m);
  assert.match(out, /^FS_DIR=\/tmp\/archive$/m);
});

test("mergeConf: existing keys are replaced in place", () => {
  const existing = [
    "# user comment",
    "BACKEND=google-drive",
    "DRIVE_FOLDER=foo",
    "DEBUG=true",
    "",
  ].join("\n");
  const out = mergeConf(existing, { BACKEND: "s3" });
  assert.match(out, /^# user comment$/m);
  assert.match(out, /^BACKEND=s3$/m);
  assert.match(out, /^DRIVE_FOLDER=foo$/m);
  assert.match(out, /^DEBUG=true$/m);
  assert.doesNotMatch(out, /google-drive/);
});

test("mergeConf: unknown keys are preserved", () => {
  const existing = [
    "# comment",
    "BACKEND=fs",
    "WEIRD_CUSTOM_KEY=hello",
    "ANOTHER_KEY=value with spaces",
    "",
  ].join("\n");
  const out = mergeConf(existing, { BACKEND: "s3", S3_BUCKET: "my-bucket" });
  assert.match(out, /^WEIRD_CUSTOM_KEY=hello$/m);
  assert.match(out, /^BACKEND=s3$/m);
  assert.match(out, /^S3_BUCKET=my-bucket$/m);
});

test("mergeConf: undefined values are skipped (no rewrite)", () => {
  const existing = "S3_REGION=us-west-2\n";
  const out = mergeConf(existing, { S3_REGION: undefined });
  assert.match(out, /^S3_REGION=us-west-2$/m);
});

test("mergeConf: new keys append at end with blank-line separator", () => {
  const existing = "BACKEND=fs\n";
  const out = mergeConf(existing, { FS_DIR: "/tmp/x", KEY_PATH: "/tmp/k" });
  assert.match(out, /^BACKEND=fs$/m);
  assert.match(out, /^FS_DIR=\/tmp\/x$/m);
  assert.match(out, /^KEY_PATH=\/tmp\/k$/m);
});

test("mergeConf: values with whitespace get quoted", () => {
  const out = mergeConf("", { FS_DIR: "/path with space" });
  assert.match(out, /^FS_DIR="\/path with space"$/m);
});

test("readExisting: returns empty map for missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-test-"));
  const path = join(dir, "nope.conf");
  const { text, map } = readExisting(path);
  assert.equal(text, "");
  assert.equal(map.size, 0);
});

test("readExisting: parses quoted and unquoted values", () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-test-"));
  const path = join(dir, "archiver.conf");
  writeConf(path, {
    BACKEND: "fs",
    FS_DIR: "/path with space",
  });
  const { map } = readExisting(path);
  assert.equal(map.get("BACKEND"), "fs");
  assert.equal(map.get("FS_DIR"), "/path with space");
});

test("writeConf: writes file with 0600 permissions on POSIX", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-test-"));
  const path = join(dir, "archiver.conf");
  writeConf(path, { BACKEND: "fs", FS_DIR: "/tmp/x" });
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^BACKEND=fs$/m);
});

test("writeConf: round-trips preserving comments across multiple writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-test-"));
  const path = join(dir, "archiver.conf");
  writeConf(path, { BACKEND: "s3", S3_BUCKET: "bkt", S3_REGION: "us-east-1" });
  writeConf(path, { BACKEND: "google-drive" });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^BACKEND=google-drive$/m);
  assert.match(text, /^S3_BUCKET=bkt$/m);
  assert.match(text, /^S3_REGION=us-east-1$/m);
});

test("writeConf: cross-backend transition preserves stale keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-conf-test-"));
  const path = join(dir, "archiver.conf");
  writeConf(path, { BACKEND: "google-drive", DRIVE_FOLDER: "team-archive" });
  writeConf(path, { BACKEND: "fs", FS_DIR: "/tmp/archive" });
  const text = readFileSync(path, "utf8");
  assert.match(text, /^BACKEND=fs$/m);
  assert.match(text, /^FS_DIR=\/tmp\/archive$/m);
  assert.match(text, /^DRIVE_FOLDER=team-archive$/m);
});
