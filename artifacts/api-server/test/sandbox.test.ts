/** The sandbox must fail closed on every escape route and enforce resource limits. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settings } from "../src/lib/config";
import { setSandboxBin } from "../src/lib/sandbox-python";
import * as tools from "../src/lib/tools";
import { execute, resolvePath } from "../src/lib/tools";

let wt: string;
const py = process.execPath; // node itself is a handy portable "program" for limit tests

before(() => {
  setSandboxBin(null);
  const base = mkdtempSync(path.join(os.tmpdir(), "rewind-sbx-"));
  wt = path.join(base, "wt");
  mkdirSync(path.join(wt, "pkg"), { recursive: true });
  writeFileSync(path.join(wt, "pkg", "a.py"), "x = 1\n");
  writeFileSync(path.join(wt, ".rewind.json"), JSON.stringify({
    test: `${py} -e "console.log('tests ok')"`,
    bigfile: `${py} -e "require('fs').writeFileSync('big.bin', Buffer.alloc(4*1024*1024, 120))"`,
    forker: `${py} -e "for (let i=0;i<3;i++){const r=require('child_process').spawnSync('true'); if (r.error) process.exit(3)} console.log('fork ok')"`,
    sleep: `${py} -e "setTimeout(()=>{}, 30000)"`,
    env: `${py} -e "console.log(Object.keys(process.env).sort().join(','))"`,
  }));
  mkdirSync(path.join(base, "outside"));
  writeFileSync(path.join(base, "outside", "secret.txt"), "secret\n");
  symlinkSync(path.join(base, "outside"), path.join(wt, "escape"));
  symlinkSync(path.join(base, "outside", "secret.txt"), path.join(wt, "leaf_link"));
});
after(() => { settings.runTimeoutSeconds = 60; settings.sandboxMaxFileMb = 64; settings.sandboxMaxProcs = 256; });

const stdout = (o: string) => o.split("--- stdout ---")[1] ?? "";

test("rejects non-whitelisted commands", async () => {
  for (const c of ["rm -rf /", "test; rm -rf /", "lint"]) {
    const out = await execute(wt, "run", { command: c });
    assert.equal(out.ok, false); assert.match(out.output, /not whitelisted/);
  }
});

test("rejects .. paths", async () => {
  await assert.rejects(resolvePath(wt, "../outside/secret.txt"), tools.ToolError);
  await assert.rejects(resolvePath(wt, "pkg/../../outside/secret.txt"), tools.ToolError);
  const out = await execute(wt, "read_file", { path: "../outside/secret.txt" });
  assert.equal(out.ok, false); assert.ok(!out.output.includes("secret\n"));
});

test("rejects absolute paths outside the worktree", async () => {
  await assert.rejects(resolvePath(wt, path.join(wt, "..", "outside", "secret.txt")), tools.ToolError);
  await assert.rejects(resolvePath(wt, "/etc/passwd"), tools.ToolError);
  const out = await execute(wt, "write_file", { path: "/tmp/rewind-escape.txt", content: "x" });
  assert.equal(out.ok, false); assert.ok(!existsSync("/tmp/rewind-escape.txt"));
  assert.equal(await resolvePath(wt, path.join(wt, "pkg", "a.py")), path.join(wt, "pkg", "a.py"));
});

test("rejects symlink escapes, including the leaf", async () => {
  await assert.rejects(resolvePath(wt, "escape/secret.txt"), /symlink/);
  await assert.rejects(resolvePath(wt, "leaf_link"), /symlink/);
  const out = await execute(wt, "write_file", { path: "leaf_link", content: "overwritten" });
  assert.equal(out.ok, false);
  assert.equal(readFileSync(path.join(wt, "..", "outside", "secret.txt"), "utf8"), "secret\n");
  await assert.rejects(resolvePath(wt, ".git/config"), tools.ToolError);
});

test("read_file on a directory lists it; unknown files hint at the listing", async () => {
  const out = await execute(wt, "read_file", { path: "." });
  assert.ok(out.ok); assert.match(out.output, /pkg\/a\.py/); assert.match(out.output, /\.rewind\.json/); assert.ok(!out.output.includes("escape/"));
  const miss = await execute(wt, "read_file", { path: "nope.py" });
  assert.equal(miss.ok, false); assert.match(miss.output, /read_file\("\."\)/);
});

test("edit_file requires exactly one match", async () => {
  writeFileSync(path.join(wt, "pkg", "a.py"), "x = 1\nx = 1\n");
  let out = await execute(wt, "edit_file", { path: "pkg/a.py", old_string: "x = 1", new_string: "x = 2" });
  assert.equal(out.ok, false); assert.match(out.output, /2 times/);
  out = await execute(wt, "edit_file", { path: "pkg/a.py", old_string: "y", new_string: "z" });
  assert.equal(out.ok, false); assert.match(out.output, /not found/);
  out = await execute(wt, "edit_file", { path: "pkg/a.py", old_string: "x = 1\nx = 1", new_string: "x = 3" });
  assert.ok(out.ok && out.mutates);
  assert.equal(readFileSync(path.join(wt, "pkg", "a.py"), "utf8"), "x = 3\n");
});

test("whitelisted command runs with a scrubbed environment", async () => {
  process.env.OPENROUTER_API_KEY = "sk-secret";
  const out = await execute(wt, "run", { command: "test" });
  assert.ok(out.ok); assert.match(out.output, /tests ok/); assert.match(out.output, /exit code: 0/);
  const env = await execute(wt, "run", { command: "env" });
  assert.ok(!env.output.includes("OPENROUTER_API_KEY"));
  for (const k of ["HOME", "PATH", "PYTHONDONTWRITEBYTECODE"]) assert.ok(stdout(env.output).includes(k), k);
});

test("timeout kills the process group", async () => {
  settings.runTimeoutSeconds = 1;
  const out = await execute(wt, "run", { command: "sleep" });
  assert.match(out.output, /exit code: timeout/); assert.match(out.output, /killed after 1s/);
  settings.runTimeoutSeconds = 60;
});

test("file size limit is enforced", async () => {
  settings.sandboxMaxFileMb = 1;
  const out = await execute(wt, "run", { command: "bigfile" });
  assert.doesNotMatch(out.output, /exit code: 0/);
  assert.ok(!existsSync(path.join(wt, "big.bin")) || statSync(path.join(wt, "big.bin")).size <= 1024 * 1024);
  settings.sandboxMaxFileMb = 64;
});

test("process limit is enforced", async () => {
  settings.sandboxMaxProcs = 1;
  const out = await execute(wt, "run", { command: "forker" });
  assert.doesNotMatch(stdout(out.output), /fork ok/);
  settings.sandboxMaxProcs = 256;
});
