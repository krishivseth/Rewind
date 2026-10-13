/** HTTP layer: auth, limits, fork snapping, context for tool_call rows, SSE replay, notes, search, delete, loops. */
import "./setup";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import path from "node:path";
import app from "../src/app";
import { FakeModelClient, setClient, type Completion, type ModelClient } from "../src/lib/client";
import { cheapestModel, settings } from "../src/lib/config";
import * as scheduler from "../src/lib/scheduler";
import { branchLimiter } from "../src/middlewares/access-key";
import { sandboxPythonStatus, setSandboxBin } from "../src/lib/sandbox-python";
import { encodeSession } from "../src/lib/auth";
import { closeDb, python, resetDb, seedRepo } from "./support";

const KEY = { "X-Rewind-Key": "test-key" };
let base = "";
let server: ReturnType<typeof app.listen>;
let repoId = "";

/** Write OUT.md for the task, read it back, finish once it matches. An edited fork rewrites it. */
class OneEditClient implements ModelClient {
  async complete(model: string, messages: Record<string, unknown>[]): Promise<Completion> {
    const task = String(messages.find((m) => m.role === "user")!.content);
    const last = messages[messages.length - 1]!;
    const want = `by ${model} for ${task}\n`;
    const call = (id: string, name: string, args: Record<string, unknown>): Completion => ({ message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, inputTokens: 100, outputTokens: 10 });
    if (last.role === "user") return call("call_w", "write_file", { path: "OUT.md", content: want });
    if (last.role === "tool" && String(last.content).startsWith("wrote")) return call("call_r", "read_file", { path: "OUT.md" });
    if (last.role === "tool" && last.content === want) return { message: { role: "assistant", content: "finished" }, inputTokens: 300, outputTokens: 10 };
    return call("call_w2", "write_file", { path: "OUT.md", content: want });
  }
}

const j = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data: data as never };
};
const get = (url: string) => j("GET", url);
async function waitDone(id: string, timeoutMs = 60_000) {
  const t = Date.now();
  while (Date.now() - t < timeoutMs) {
    const { data } = await get(`/api/branches/${id}`);
    if (["done", "failed", "cancelled"].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("branch did not finish");
}
const newSession = (task = "do it") => j("POST", "/api/sessions", { repo_id: repoId, title: "t", task_prompt: task, model_id: cheapestModel().id }, KEY);

before(async () => {
  await python();
  server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
beforeEach(async () => { await resetDb(); setClient(new OneEditClient()); branchLimiter.reset(); repoId = (await seedRepo("csv-stats")).id; settings.rateLimitBranchesPerHour = 10; settings.dailyTokenCap = 2_000_000; });
after(async () => { await scheduler.waitAll(); server.close(); await closeDb(); });

test("auth", async () => {
  assert.equal((await get("/api/auth/check")).status, 401);
  assert.equal((await j("GET", "/api/auth/check", undefined, { "X-Rewind-Key": "wrong" })).status, 401);
  assert.equal((await j("GET", "/api/auth/check", undefined, KEY)).status, 200);
  assert.equal((await j("POST", "/api/sessions", {})).status, 401);
});

test("create session, run, inspect, stream", async () => {
  const r = await newSession();
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const root = r.data.root_branch_id as string;
  const b = await waitDone(root);
  assert.equal(b.status, "done", JSON.stringify(b));
  assert.equal(b.step_count, 8);
  assert.equal(b.stop_reason, "completed");
  assert.equal(b.total_input_tokens, 500);
  const steps = (await get(`/api/branches/${root}/steps`)).data as Array<Record<string, unknown>>;
  assert.deepEqual(steps.map((s) => s.kind), ["user", "assistant", "tool_call", "tool_result", "assistant", "tool_call", "tool_result", "assistant"]);
  assert.ok(steps[3]!.commit_hash); assert.deepEqual(steps[3]!.files_changed, ["OUT.md"]);

  const files = (await get(`/api/branches/${root}/steps/3/files`)).data;
  assert.ok(files.files.some((f: { path: string; changed: boolean }) => f.path === "OUT.md" && f.changed));
  assert.equal((await get(`/api/branches/${root}/steps/0/file?path=OUT.md`)).status, 404);
  const f = (await get(`/api/branches/${root}/steps/3/file?path=OUT.md&with_previous=true`)).data;
  assert.ok(String(f.content).startsWith("by ")); assert.equal(f.previous_content, null);
  const baseFiles = (await get(`/api/branches/${root}/steps/0/files`)).data;
  assert.ok(baseFiles.files.every((x: { changed: boolean }) => !x.changed)); assert.ok(baseFiles.files.some((x: { path: string }) => x.path === "csv_stats.py"));

  const ctx = (await get(`/api/branches/${root}/steps/2/context`)).data;
  assert.equal(ctx.step_index, 1); assert.equal(ctx.requested_index, 2);
  assert.deepEqual(ctx.messages.map((m: { role: string }) => m.role), ["system", "user", "assistant"]);
  const ctx3 = (await get(`/api/branches/${root}/steps/3/context`)).data;
  assert.deepEqual(ctx3.messages.map((m: { role: string }) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(ctx3.token_count, 100); assert.equal(ctx3.token_count_source, "reported");

  const text = await (await fetch(`${base}/api/branches/${root}/events`)).text();
  const events = text.split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as { type: string; data: { status?: string } });
  assert.deepEqual(events.map((e) => e.type), [...Array(8).fill("step"), "status"]);
  assert.equal(events.at(-1)!.data.status, "done");

  const sess = (await get(`/api/sessions/${r.data.id}`)).data;
  assert.equal(sess.branches.length, 1); assert.equal(sess.repo_slug, "csv-stats");
  const list = (await get("/api/sessions")).data;
  assert.equal(list[0].branch_count, 1); assert.equal(list[0].model_id, cheapestModel().id);
});

test("fork snaps to a valid boundary and reports it; cross-branch diff", async () => {
  const r = await newSession();
  const root = r.data.root_branch_id as string;
  await waitDone(root);
  const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 5, model_id: cheapestModel().id, count: 2, edited_task_prompt: "changed" }, KEY);
  assert.equal(f.status, 201, JSON.stringify(f.data));
  assert.equal(f.data.requested_step_index, 5); assert.equal(f.data.fork_step_index, 3); assert.equal(f.data.snapped, true);
  assert.equal(f.data.branches.length, 2);
  const rootSteps = (await get(`/api/branches/${root}/steps`)).data;
  for (const fb of f.data.branches) {
    assert.equal(fb.parent_branch_id, root); assert.equal(fb.fork_step_index, 3); assert.equal(fb.task_prompt, "changed");
    const done = await waitDone(fb.id);
    assert.equal(done.status, "done", JSON.stringify(done));
    const s = (await get(`/api/branches/${fb.id}/steps`)).data;
    assert.equal(s[0].content.content, "changed");
    assert.equal(s[3].commit_hash, rootSteps[3].commit_hash);
  }
  const ok = await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: cheapestModel().id }, KEY);
  assert.equal(ok.data.snapped, false); assert.equal(ok.data.fork_step_index, 3);
  await waitDone(ok.data.branches[0].id);
  const d = (await get(`/api/diff?a=${root}&b=${f.data.branches[0].id}`)).data;
  assert.deepEqual(d.files, ["OUT.md"]); assert.match(d.patch, /\+by /); assert.match(d.patch, /for changed/);
  const same = (await get(`/api/diff?a=${root}:3&b=${f.data.branches[0].id}:3`)).data;
  assert.deepEqual(same.files, []); assert.equal(same.a.commit, same.b.commit);
  assert.equal((await get(`/api/sessions/${r.data.id}`)).data.branches.length, 4);
});

test("rate limit and daily cap", async () => {
  settings.rateLimitBranchesPerHour = 2;
  assert.equal((await newSession()).status, 201);
  assert.equal((await newSession()).status, 201);
  const r = await newSession();
  assert.equal(r.status, 429); assert.match(r.data.detail, /rate limit/);
  settings.rateLimitBranchesPerHour = 100;
  settings.dailyTokenCap = 1;
  await scheduler.waitAll();
  const c = await newSession();
  assert.equal(c.status, 429); assert.match(c.data.detail, /daily token cap/);
});

test("cancel", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const inner = new OneEditClient();
  setClient({ complete: async (...a) => { await gate; return inner.complete(...a); } });
  const r = await newSession();
  const root = r.data.root_branch_id as string;
  await new Promise((x) => setTimeout(x, 300));
  assert.equal((await j("POST", `/api/branches/${root}/cancel`)).status, 401);
  assert.equal((await j("POST", `/api/branches/${root}/cancel`, undefined, KEY)).status, 200);
  release();
  const b = await waitDone(root);
  assert.equal(b.status, "cancelled"); assert.match(b.error, /cancelled/); assert.ok(b.bundle_key);
});

test("validation", async () => {
  assert.equal((await j("POST", "/api/sessions", { repo_id: repoId, title: "t", task_prompt: "x", model_id: "nope/model" }, KEY)).status, 422);
  assert.equal((await j("POST", `/api/branches/00000000-0000-4000-8000-000000000000/fork`, { step_index: 0, model_id: cheapestModel().id, count: 6 }, KEY)).status, 404);
  assert.equal((await get(`/api/branches/00000000-0000-4000-8000-000000000000/steps`)).status, 404);
  assert.equal((await get(`/api/diff?a=x&b=y`)).status, 400);
});

test("notes, search, delete", async () => {
  const r = await newSession("search-me-task");
  const sid = r.data.id as string, root = r.data.root_branch_id as string;
  await waitDone(root);
  assert.equal((await j("PUT", `/api/branches/${root}/steps/1/note`, { note: "trying x" })).status, 401);
  const n = await j("PUT", `/api/branches/${root}/steps/1/note`, { note: "trying x" }, KEY);
  assert.equal(n.status, 200); assert.equal(n.data.note, "trying x");
  const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: cheapestModel().id }, KEY);
  await waitDone(f.data.branches[0].id);
  assert.equal((await get(`/api/branches/${f.data.branches[0].id}/steps`)).data[1].note, "trying x");
  const hits = (await get("/api/search?q=OUT.md")).data.results;
  assert.ok(hits.length > 0); assert.ok(hits.every((h: { snippet: string }) => h.snippet.includes("OUT.md")));
  assert.equal((await get("/api/search?q=trying%20x")).data.results[0].step_index, 1);
  assert.ok((await get("/api/search?q=search-me-task")).data.results.length > 0);
  assert.equal((await get("/api/search?q=x")).status, 422);
  const bundle = (await get(`/api/branches/${root}`)).data.bundle_key as string;
  assert.equal((await j("DELETE", `/api/sessions/${sid}`)).status, 401);
  const d = await j("DELETE", `/api/sessions/${sid}`, undefined, KEY);
  assert.equal(d.status, 200); assert.equal(d.data.branches_deleted, 2);
  assert.equal((await get(`/api/sessions/${sid}`)).status, 404);
  assert.equal((await get(`/api/branches/${root}`)).status, 404);
  assert.ok(!existsSync(path.join(settings.dataDir, "storage", bundle)));
  assert.deepEqual((await get("/api/search?q=trying%20x")).data.results, []);
});

test("loop detection", async () => {
  setClient({ complete: async (_m, messages) => ({ message: { role: "assistant", content: null, tool_calls: [{ id: `c${messages.length}`, type: "function", function: { name: "run", arguments: JSON.stringify({ command: "test" }) } }] }, inputTokens: 10, outputTokens: 1 }) });
  const r = await newSession("loop");
  const b = await waitDone(r.data.root_branch_id);
  assert.equal(b.status, "done"); assert.equal(b.stop_reason, "loop"); assert.match(b.error, /same arguments/);
  const all = (await get(`/api/branches/${b.id}/steps`)).data as Array<{ kind: string; tool_result: string; content: { content?: string } }>;
  assert.ok(all.some((s) => s.kind === "user" && /This run is stopping/.test(s.content.content ?? "")));
  const results = all.filter((s) => s.kind === "tool_result");
  // the test command fails every time, so the branch ends one attempt early
  assert.equal(results.length, settings.loopFailAfter - 1);
  assert.ok(results.some((r) => /\[rewind\].*failed each time/.test(r.tool_result)));
  assert.doesNotMatch(results[0]!.tool_result, /\[rewind\]/);
});

test("twenty concurrent branches", async () => {
  settings.rateLimitBranchesPerHour = 100;
  const r = await newSession();
  const root = r.data.root_branch_id as string;
  await waitDone(root);
  const ids: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: cheapestModel().id, count: 5, edited_task_prompt: "y" }, KEY);
    assert.equal(f.status, 201, JSON.stringify(f.data));
    ids.push(...f.data.branches.map((b: { id: string }) => b.id));
  }
  assert.equal(ids.length, 20);
  const sess = (await get(`/api/sessions/${r.data.id}`)).data;
  const queued = sess.branches.filter((b: { status: string }) => b.status === "queued");
  assert.ok(queued.length > 0); assert.ok(queued.every((b: { queue_position?: number }) => b.queue_position));
  for (const id of ids) assert.equal((await waitDone(id, 120_000)).status, "done");
});

test("writes are gated while warming up, in read-only mode, and over the session budget", async () => {
  const bin = sandboxPythonStatus().bin;
  setSandboxBin(null);
  let r = await newSession();
  assert.equal(r.status, 503); assert.match(r.data.detail, /warming up/);
  setSandboxBin(bin);
  settings.readOnly = true;
  r = await newSession();
  assert.equal(r.status, 503); assert.match(r.data.detail, /read-only/);
  assert.equal((await get("/api/stats")).data.writes, "read_only");
  settings.readOnly = false;
  assert.equal((await get("/api/stats")).data.writes, "open");

  r = await newSession();
  const root = r.data.root_branch_id as string;
  await waitDone(root);
  settings.maxTotalTokensPerSession = 100;
  const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: cheapestModel().id }, KEY);
  assert.equal(f.status, 429); assert.match(f.data.detail, /budget/);
  settings.maxTotalTokensPerSession = 300_000;
  assert.ok((await get(`/api/branches/${root}`)).data.est_cost_usd >= 0);
});

test("readiness pings the database and 500s are generic", async () => {
  const r = await get("/api/ready");
  assert.equal(r.status, 200); assert.equal(r.data.db, "ok");
  // a step index that is not a number reaches the handler and must not leak internals
  const bad = await get(`/api/branches/00000000-0000-4000-8000-000000000000/steps/abc/files`);
  assert.ok([404, 500].includes(bad.status));
  if (bad.status === 500) assert.equal(bad.data.detail, "Internal error. The server log has the details.");
});

test("public cheap-model writes", async () => {
  settings.publicWrites = "cheap";
  const noKey = (body: Record<string, unknown>) => j("POST", "/api/sessions", body, {});
  const other = "anthropic/claude-sonnet-5";
  let r = await noKey({ repo_id: repoId, title: "t", task_prompt: "x", model_id: other });
  assert.equal(r.status, 401); assert.match(r.data.detail, /Visitors can run/);
  r = await noKey({ repo_id: repoId, title: "t", task_prompt: "x", model_id: cheapestModel().id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const root = r.data.root_branch_id as string;
  await waitDone(root);
  const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: cheapestModel().id }, {});
  assert.equal(f.status, 201);
  assert.equal((await j("POST", `/api/branches/${root}/fork`, { step_index: 3, model_id: other }, {})).status, 401);
  // public budget is separate from the global cap
  settings.publicDailyTokenCap = 1;
  await scheduler.waitAll();
  r = await noKey({ repo_id: repoId, title: "t", task_prompt: "x", model_id: cheapestModel().id });
  assert.equal(r.status, 429); assert.match(r.data.detail, /public budget/);
  const keyed = await newSession(); // the key is not subject to the public budget
  assert.equal(keyed.status, 201);
  await waitDone(keyed.data.root_branch_id);
  settings.publicDailyTokenCap = 500_000;
  settings.publicWrites = "off";
  r = await noKey({ repo_id: repoId, title: "t", task_prompt: "x", model_id: cheapestModel().id });
  assert.equal(r.status, 401);
  settings.publicWrites = "cheap";
  assert.equal((await get("/api/stats")).data.public_writes, "cheap");
});

test("signed-in mode: GitHub session unlocks cheap-model writes with a shorter run", async () => {
  settings.publicWrites = "signed_in";
  settings.sessionSecret = "test-session-secret";
  const body = { repo_id: repoId, title: "t", task_prompt: "x", model_id: cheapestModel().id };
  let r = await j("POST", "/api/sessions", body, {});
  assert.equal(r.status, 401); assert.equal(r.data.sign_in, true);
  const cookie = `rewind_session=${encodeSession({ id: "42", login: "octocat", avatar: null })}`;
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie } }).then((x) => x.json());
  assert.equal((me as { login: string }).login, "octocat");
  assert.equal((await j("GET", "/api/auth/me", undefined, { Cookie: "rewind_session=tampered.sig" })).data, null);
  r = await j("POST", "/api/sessions", body, { Cookie: cookie });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await j("POST", "/api/sessions", { ...body, model_id: "anthropic/claude-sonnet-5" }, { Cookie: cookie })).status, 401);
  const done = await waitDone(r.data.root_branch_id);
  assert.equal(done.status, "done");
  // a public branch is capped at PUBLIC_MAX_MODEL_CALLS; the last call is a tool-less wrap-up and the branch ends done
  settings.publicMaxModelCalls = 2;
  r = await j("POST", "/api/sessions", body, { Cookie: cookie });
  const capped = await waitDone(r.data.root_branch_id);
  assert.equal(capped.status, "done"); assert.equal(capped.stop_reason, "call_limit"); assert.match(capped.error, /2-call limit/);
  const cappedSteps = (await get(`/api/branches/${capped.id}/steps`)).data as Array<{ kind: string; content: { content?: string } }>;
  assert.ok(cappedSteps.some((s) => s.kind === "user" && /This run is stopping/.test(s.content.content ?? "")));
  assert.equal(cappedSteps.filter((s) => s.kind === "assistant").length, 2);
  settings.publicMaxModelCalls = 20;
  settings.publicWrites = "cheap";
});

test("a fork before the parent's first commit starts from the base repo, not the parent's HEAD", async () => {
  const r = await newSession();
  const root = r.data.root_branch_id as string;
  await waitDone(root);
  // step 1 is the first assistant turn; no commit exists at or before it
  const f = await j("POST", `/api/branches/${root}/fork`, { step_index: 1, model_id: cheapestModel().id, edited_task_prompt: "again" }, KEY);
  assert.equal(f.status, 201, JSON.stringify(f.data));
  const fid = f.data.branches[0].id as string;
  const done = await waitDone(fid);
  assert.equal(done.status, "done", JSON.stringify(done));
  const files0 = (await get(`/api/branches/${fid}/steps/1/files`)).data;
  assert.ok(!files0.files.some((x: { path: string }) => x.path === "OUT.md"), "parent's OUT.md must not exist at the fork point");
  const steps = (await get(`/api/branches/${fid}/steps`)).data as Array<{ kind: string; tool_name: string | null; commit_hash: string | null }>;
  const firstWrite = steps.find((s) => s.kind === "tool_result" && s.tool_name === "write_file");
  assert.ok(firstWrite?.commit_hash, "the fork wrote OUT.md itself");
});

test("fake client sanity", () => { assert.ok(new FakeModelClient([])); });
