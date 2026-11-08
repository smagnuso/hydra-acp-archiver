import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchConfigPath } from "../../src/util/watch.js";

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

function changed(path: string, write: () => void): Promise<boolean> {
  return new Promise((resolve) => {
    // Not unref'd. The watcher is non-persistent, so without a live timer the
    // process can exit between the write and the event, which node:test
    // reports as a cancelled test rather than a failed one.
    const finish = (value: boolean): void => {
      clearTimeout(giveUp);
      clearTimeout(writeTimer);
      handle.stop();
      resolve(value);
    };
    const giveUp = setTimeout(() => finish(false), 4000);
    const handle = watchConfigPath({
      path,
      debounceMs: 20,
      onChange: () => finish(true),
    });
    // Past the watcher arming, so the event is not lost to a race.
    const writeTimer = setTimeout(write, 100);
  });
}

test("watchConfigPath fires when the config file appears", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-watch-"));
  try {
    const p = join(dir, "rule.config.js");
    assert.equal(await changed(p, () => writeFileSync(p, "export default () => null;\n")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// fs.watch reports the name as it is on disk. A path written with different
// casing names the same file on Windows, so it has to match there.
test(
  "watchConfigPath matches the file name case-insensitively on Windows",
  { skip: process.platform !== "win32" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "archiver-watch-"));
    try {
      const watched = join(dir, "Rule.Config.js");
      const onDisk = join(dir, "rule.config.js");
      assert.equal(
        await changed(watched, () => writeFileSync(onDisk, "export default () => null;\n")),
        true,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("watchConfigPath fires when an existing config file is rewritten", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-watch-"));
  try {
    const p = join(dir, "rule.config.js");
    writeFileSync(p, "export default () => true;\n");
    // macOS can report a write made just before the watcher started; let that
    // settle so the event below is the rewrite and not the setup write.
    await sleep(600);
    assert.equal(await changed(p, () => writeFileSync(p, "export default () => false;\n")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watchConfigPath ignores other files in the same directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archiver-watch-"));
  try {
    const p = join(dir, "rule.config.js");
    const other = join(dir, "other.txt");
    assert.equal(await changed(p, () => writeFileSync(other, "x")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
