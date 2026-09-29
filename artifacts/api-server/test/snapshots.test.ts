/** Per-tool-call snapshots of a project tree, without touching the project's own .git. */
import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "../src/lib/gitwrap";
import { SnapshotStore } from "../src/lib/opencode/snapshots";

async function makeProject() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "rewind-snap-"));
  const proj = path.join(tmp, "proj");
  mkdirSync(proj);
  await git.init(proj);
  writeFileSync(path.join(proj, "a.txt"), "one\n");
  await git.commitAll(proj, "user's own history");
  return { tmp, proj };
}

test("commit and checkout restore the exact tree", async () => {
  const { tmp, proj } = await makeProject();
  const store = new SnapshotStore("ses_x", proj, path.join(tmp, "data"));
  const base = await store.init();
  assert.equal(store.gitDir, path.join(tmp, "data", "snapshots", "ses_x"));
  writeFileSync(path.join(proj, "a.txt"), "two\n");
  writeFileSync(path.join(proj, "b.txt"), "new\n");
  const c1 = await store.commit("step 1");
  assert.ok(c1 && c1 !== base);
  assert.deepEqual((await store.filesChangedIn(c1!)).sort(), ["a.txt", "b.txt"]);
  assert.equal(await store.commit("nothing"), null);
  writeFileSync(path.join(proj, "c.txt"), "later\n");
  writeFileSync(path.join(proj, "a.txt"), "three\n");
  await store.checkout(c1!);
  assert.equal(readFileSync(path.join(proj, "a.txt"), "utf8"), "two\n");
  assert.ok(existsSync(path.join(proj, "b.txt")));
  assert.ok(!existsSync(path.join(proj, "c.txt")));
  await store.checkout(base);
  assert.equal(readFileSync(path.join(proj, "a.txt"), "utf8"), "one\n");
  assert.ok(!existsSync(path.join(proj, "b.txt")));
  assert.equal(await store.rootCommit(), base);
});

test("the project's git is untouched and not snapshotted", async () => {
  const { tmp, proj } = await makeProject();
  const before = await git.head(proj);
  const store = new SnapshotStore("ses_y", proj, path.join(tmp, "data"));
  const c = await store.init();
  assert.equal(await git.head(proj), before);
  const tree = await git.git(proj, ["--git-dir", store.gitDir, "ls-tree", "-r", "--name-only", c]);
  const names = tree.split("\n");
  assert.ok(!names.includes(".git/HEAD"));
  assert.ok(names.includes("a.txt"));
});

test("bundle restores history", async () => {
  const { tmp, proj } = await makeProject();
  const store = new SnapshotStore("ses_z", proj, path.join(tmp, "data"));
  await store.init();
  writeFileSync(path.join(proj, "a.txt"), "two\n");
  const c1 = (await store.commit("s1"))!;
  const bundle = await store.bundle(path.join(tmp, "out.bundle"));
  const clone = path.join(tmp, "clone");
  await git.cloneBundle(bundle, clone, tmp);
  assert.ok(await git.commitExists(clone, c1));
  assert.equal((await git.showFile(clone, c1, "a.txt")).toString(), "two\n");
});
