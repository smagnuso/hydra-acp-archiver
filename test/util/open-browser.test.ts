import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import { test } from "node:test";
import { openBrowser } from "../../src/util/open-browser.js";

interface Call {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function fakeSpawn() {
  const calls: Call[] = [];
  const children: EventEmitter[] = [];
  const spawn = (command: string, args: string[], options: SpawnOptions) => {
    calls.push({ command, args, options });
    const child = Object.assign(new EventEmitter(), { unref() {} });
    children.push(child);
    return child;
  };
  return { calls, children, spawn };
}

const URL_SPECIAL = "https://accounts.example.com/o?a=1&b=%2F&c=x#frag";

test("win32: rundll32, no shell, not detached, hidden, URL as one arg", () => {
  const f = fakeSpawn();
  openBrowser(URL_SPECIAL, () => {}, { platform: "win32", spawn: f.spawn });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0]!.command, "rundll32");
  assert.deepEqual(f.calls[0]!.args, ["url.dll,FileProtocolHandler", URL_SPECIAL]);
  assert.deepEqual(f.calls[0]!.options, { stdio: "ignore", windowsHide: true });
});

test("darwin: open, detached", () => {
  const f = fakeSpawn();
  openBrowser(URL_SPECIAL, () => {}, { platform: "darwin", spawn: f.spawn });
  assert.equal(f.calls[0]!.command, "open");
  assert.deepEqual(f.calls[0]!.args, [URL_SPECIAL]);
  assert.deepEqual(f.calls[0]!.options, { stdio: "ignore", detached: true });
});

test("linux: xdg-open, detached", () => {
  const f = fakeSpawn();
  openBrowser(URL_SPECIAL, () => {}, { platform: "linux", spawn: f.spawn });
  assert.equal(f.calls[0]!.command, "xdg-open");
  assert.deepEqual(f.calls[0]!.args, [URL_SPECIAL]);
  assert.deepEqual(f.calls[0]!.options, { stdio: "ignore", detached: true });
});

for (const platform of ["win32", "darwin", "linux"] as const) {
  test(`${platform}: spawn error event invokes the failure fallback once`, () => {
    const f = fakeSpawn();
    let failures = 0;
    openBrowser(URL_SPECIAL, () => failures++, { platform, spawn: f.spawn });
    assert.equal(failures, 0);
    f.children[0]!.emit("error", new Error("ENOENT"));
    assert.equal(failures, 1);
  });

  test(`${platform}: synchronous spawn throw invokes the failure fallback`, () => {
    let failures = 0;
    openBrowser("https://x", () => failures++, {
      platform,
      spawn: () => {
        throw new Error("boom");
      },
    });
    assert.equal(failures, 1);
  });
}
