import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { runHydraAcp } from "../../src/setup/run-hydra.js";

let dir: string;
let env: NodeJS.ProcessEnv;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "archiver-runhydra-"));
  writeFileSync(join(dir, "hydra-acp.cmd"), "@echo off\n");
  env = { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" };
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

function recorder(status: number | null) {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawnSync = (command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return { status };
  };
  return { calls, spawnSync };
}

test("win32: resolves hydra-acp.cmd and spawns it through the shell", () => {
  const r = recorder(0);
  const out = runHydraAcp(["extensions", "add", "hydra-acp-archiver"], {
    env,
    platform: "win32",
    spawnSync: r.spawnSync,
  });
  assert.deepEqual(out, { kind: "exited", status: 0 });
  assert.equal(r.calls[0]!.command.replace(/"/g, "").toLowerCase(), join(dir, "hydra-acp.cmd").toLowerCase());
  assert.equal(r.calls[0]!.options["shell"], true);
  assert.equal(r.calls[0]!.options["stdio"], "inherit");
});

test("win32: unquotable script path is reported, not thrown, and nothing is spawned", () => {
  const r = recorder(0);
  const out = runHydraAcp(["extensions", "add", "x", "--args", "C:\\100%\\a.js"], {
    env,
    platform: "win32",
    spawnSync: r.spawnSync,
  });
  assert.deepEqual(out, { kind: "unquotable" });
  assert.equal(r.calls.length, 0);
});

test("posix: bare hydra-acp, no shell, args untouched even with % and spaces", () => {
  const r = recorder(3);
  const args = ["extensions", "add", "x", "--args", "/tmp/a b/100%/a.js"];
  const out = runHydraAcp(args, { env, platform: "linux", spawnSync: r.spawnSync });
  assert.deepEqual(out, { kind: "exited", status: 3 });
  assert.equal(r.calls[0]!.command, "hydra-acp");
  assert.deepEqual(r.calls[0]!.args, args);
  assert.equal(r.calls[0]!.options["shell"], false);
});
