import { strict as assert } from "node:assert";
import { test } from "node:test";
import { collapseHome, expandHome } from "../../src/util/home.js";

test("expandHome: bare ~, ~/x and ~\\x expand", () => {
  assert.equal(expandHome("~", "H"), "H");
  assert.equal(expandHome("~/archive", "H"), "H/archive");
  assert.equal(expandHome("~\\archive", "H"), "H\\archive");
});

test("expandHome: other input is untouched", () => {
  assert.equal(expandHome("~user/x", "H"), "~user/x");
  assert.equal(expandHome("a/~/b", "H"), "a/~/b");
  assert.equal(expandHome("/abs", "H"), "/abs");
  assert.equal(expandHome("C:\\x", "H"), "C:\\x");
});

test("collapseHome: POSIX abbreviates the home prefix", () => {
  assert.equal(collapseHome("/home/u/proj", "/home/u", "linux"), "~/proj");
  assert.equal(collapseHome("/other/proj", "/home/u", "darwin"), "/other/proj");
  assert.equal(collapseHome("/x", undefined, "linux"), "/x");
});

test("collapseHome: win32 never abbreviates", () => {
  assert.equal(collapseHome("C:\\Users\\u\\proj", "C:\\Users\\u", "win32"), "C:\\Users\\u\\proj");
});
