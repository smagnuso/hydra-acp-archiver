import { strict as assert } from "node:assert";
import { test } from "node:test";
import { confLockNote, confWrittenMessage, isTransientNpxPath } from "../../src/setup/platform-text.js";

test("isTransientNpxPath: POSIX and Windows npx caches", () => {
  assert.equal(isTransientNpxPath("/home/u/.npm/_npx/abc123/node_modules/x/dist/index.js"), true);
  assert.equal(
    isTransientNpxPath("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc123\\node_modules\\x\\dist\\index.js"),
    true,
  );
});

test("isTransientNpxPath: regular install paths are not transient", () => {
  assert.equal(isTransientNpxPath("/usr/lib/node_modules/x/dist/index.js"), false);
  assert.equal(isTransientNpxPath("C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\x\\dist\\index.js"), false);
});

test("confWrittenMessage: POSIX keeps chmod 600, win32 omits it", () => {
  assert.equal(confWrittenMessage("/p/archiver.conf", "linux"), "Wrote /p/archiver.conf (chmod 600).");
  assert.equal(confWrittenMessage("/p/archiver.conf", "darwin"), "Wrote /p/archiver.conf (chmod 600).");
  const w = confWrittenMessage("C:\\p\\archiver.conf", "win32");
  assert.doesNotMatch(w, /chmod/);
  assert.match(w, /Windows file modes are not applied/);
});

test("confLockNote: POSIX keeps chmod 600, win32 omits it", () => {
  assert.equal(confLockNote("linux"), "# Lock this file: chmod 600.");
  assert.doesNotMatch(confLockNote("win32"), /chmod/);
});
