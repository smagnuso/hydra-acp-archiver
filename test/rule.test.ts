import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_RULE, loadRule } from "../src/rule.js";

const EV = {
  sessionId: "s1",
  lineageId: "hydra_lineage_aaaa",
  meta: { cwd: "/tmp", title: "demo" },
};

test("loadRule returns DEFAULT_RULE when file is missing", async () => {
  const fn = await loadRule("/does/not/exist.js");
  assert.equal(fn, DEFAULT_RULE);
});

test("DEFAULT_RULE archives every session", async () => {
  const r = await DEFAULT_RULE(EV);
  assert.equal(r, true);
});

test("loadRule imports a JS module's default export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-rule-"));
  try {
    const p = join(dir, "rule.js");
    writeFileSync(
      p,
      'export default function rule(ev) { return ev.meta.cwd !== "/skip"; }\n',
      "utf8",
    );
    const fn = await loadRule(p);
    assert.notEqual(fn, DEFAULT_RULE);
    assert.equal(await fn({ ...EV, meta: { cwd: "/keep" } }), true);
    assert.equal(await fn({ ...EV, meta: { cwd: "/skip" } }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRule falls back to DEFAULT_RULE when no default export", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-rule-"));
  try {
    const p = join(dir, "rule.js");
    writeFileSync(p, "export const foo = 1;\n", "utf8");
    const fn = await loadRule(p);
    assert.equal(fn, DEFAULT_RULE);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
