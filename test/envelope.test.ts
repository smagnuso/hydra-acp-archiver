import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deserialize,
  hashBundle,
  keyFor,
  serialize,
  unwrap,
  wrap,
  SYNC_VERSION,
} from "../src/envelope.js";

const HOST = { host: "test-host", user: "test-user" };
const LINEAGE = "hydra_lineage_abcdef0123456789";
const FIXED_NOW = new Date("2026-05-20T12:00:00.000Z");

const SAMPLE_BUNDLE = {
  version: 1,
  exportedAt: "2026-05-20T11:00:00.000Z",
  session: { sessionId: "s1", lineageId: LINEAGE, cwd: "/tmp/x" },
  history: [{ role: "user", text: "hi" }],
};

test("wrap round-trips through serialize/deserialize", () => {
  const env = wrap(SAMPLE_BUNDLE, LINEAGE, HOST, FIXED_NOW);
  const bytes = serialize(env);
  const back = deserialize(bytes);
  assert.equal(back.syncVersion, SYNC_VERSION);
  assert.equal(back.lineageId, LINEAGE);
  assert.equal(back.uploadedAt, FIXED_NOW.toISOString());
  assert.deepEqual(back.uploadedBy, HOST);
  assert.equal(back.bundleHash, env.bundleHash);
  assert.deepEqual(back.bundle, SAMPLE_BUNDLE);
});

test("hashBundle is stable across object key reordering", () => {
  const a = { x: 1, y: { c: 3, a: [1, 2] } };
  const b = { y: { a: [1, 2], c: 3 }, x: 1 };
  assert.equal(hashBundle(a), hashBundle(b));
});

test("hashBundle distinguishes array order", () => {
  const a = { history: [{ a: 1 }, { a: 2 }] };
  const b = { history: [{ a: 2 }, { a: 1 }] };
  assert.notEqual(hashBundle(a), hashBundle(b));
});

test("unwrap rejects unsupported syncVersion", () => {
  assert.throws(() =>
    unwrap({
      syncVersion: 999,
      lineageId: LINEAGE,
      uploadedAt: FIXED_NOW.toISOString(),
      uploadedBy: HOST,
      bundleHash: "sha256:deadbeef",
      bundle: {},
    }),
    /syncVersion/,
  );
});

test("unwrap rejects missing required fields", () => {
  assert.throws(() =>
    unwrap({
      syncVersion: SYNC_VERSION,
      uploadedAt: FIXED_NOW.toISOString(),
      uploadedBy: HOST,
      bundleHash: "sha256:deadbeef",
      bundle: {},
    }),
    /lineageId/,
  );
});

test("keyFor produces expected filename", () => {
  assert.equal(keyFor(LINEAGE), `${LINEAGE}.hydra.sync`);
});
