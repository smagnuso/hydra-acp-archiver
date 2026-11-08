import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  quoteForCmd,
  resolveSpawnTarget,
  resolveWindowsCommand,
} from "../../src/util/windows-command.js";

let dir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "archiver-wincmd-"));
  writeFileSync(join(dir, "hydra-acp"), "#!/bin/sh\n");
  writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
  writeFileSync(join(dir, "tool.exe"), "MZ");
  mkdirSync(join(dir, "sub"));
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const lc = (s: string) => s.toLowerCase();

test("resolveWindowsCommand: identity off win32 even with a .cmd sibling", () => {
  assert.equal(resolveWindowsCommand("hydra-acp", { env, platform: "linux" }), "hydra-acp");
  assert.equal(resolveWindowsCommand("hydra-acp", { env, platform: "darwin" }), "hydra-acp");
});

test("resolveWindowsCommand: win32 prefers the .cmd over the extensionless sh shim", () => {
  const out = resolveWindowsCommand("hydra-acp", { env, platform: "win32" });
  assert.equal(lc(out), lc(join(dir, "hydra-acp.cmd")));
});

test("resolveWindowsCommand: win32 finds .exe and passes unknown commands through", () => {
  assert.equal(lc(resolveWindowsCommand("tool", { env, platform: "win32" })), lc(join(dir, "tool.exe")));
  assert.equal(resolveWindowsCommand("nope", { env, platform: "win32" }), "nope");
});

test("resolveWindowsCommand: a command that already has an extension is unchanged", () => {
  assert.equal(resolveWindowsCommand("x.exe", { env, platform: "win32" }), "x.exe");
});

test("quoteForCmd: plain tokens untouched, special characters quoted", () => {
  assert.equal(quoteForCmd("abc"), "abc");
  assert.equal(quoteForCmd("a b"), '"a b"');
  assert.equal(quoteForCmd("a&b"), '"a&b"');
});

test("quoteForCmd: refuses quote, percent, CR and LF", () => {
  for (const bad of ['a"b', "%PATH%", "a\rb", "a\nb"]) {
    assert.throws(() => quoteForCmd(bad), /cannot pass/);
  }
});

test("resolveSpawnTarget: win32 .cmd goes through the shell, quoted", () => {
  const t = resolveSpawnTarget("hydra-acp", ["extensions", "add", "C:\\My Dir\\a.js"], {
    env,
    platform: "win32",
  });
  assert.equal(t.shell, true);
  assert.equal(lc(t.command.replace(/"/g, "")), lc(join(dir, "hydra-acp.cmd")));
  assert.deepEqual(t.args, ["extensions", "add", '"C:\\My Dir\\a.js"']);
});

test("resolveSpawnTarget: win32 .exe is spawned directly", () => {
  const t = resolveSpawnTarget("tool", ["a b"], { env, platform: "win32" });
  assert.equal(t.shell, false);
  assert.deepEqual(t.args, ["a b"]);
});

test("resolveSpawnTarget: POSIX is identity with no shell", () => {
  const t = resolveSpawnTarget("hydra-acp", ["a b", "%x%"], { env, platform: "linux" });
  assert.deepEqual(t, { command: "hydra-acp", args: ["a b", "%x%"], shell: false });
});

test("resolveSpawnTarget: win32 .cmd throws on an unquotable arg", () => {
  assert.throws(() => resolveSpawnTarget("hydra-acp", ["50%"], { env, platform: "win32" }));
});
