/** Creating an OpenCode-runner session starts a session on the server and a recorder task. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { branches, db, repos } from "@workspace/db";
import app from "../src/app";
import { FakeModelClient, setClient } from "../src/lib/client";
import { OpenCodeClient } from "../src/lib/opencode/client";
import * as scheduler from "../src/lib/scheduler";
import { runningRecorders } from "../src/lib/opencode/session";
import { SnapshotStore } from "../src/lib/opencode/snapshots";
import * as services from "../src/lib/services";
import { closeDb, python, resetDb, settings } from "./support";

const calls: Array<[string, string, unknown]> = [];
const fakeFetch: typeof fetch = async (url, init) => {
  const p = new URL(String(url)).pathname;
  calls.push([init?.method ?? "GET", p, init?.body ? JSON.parse(String(init.body)) : null]);
  if (p === "/session") return new Response(JSON.stringify({ id: "ses_live" }), { status: 200 });
  if (p.endsWith("/prompt_async")) return new Response(null, { status: 204 });
  if (p === "/event") return new Response('data: {"type":"server.connected","properties":{}}\n\ndata: {"type":"session.idle","properties":{"sessionID":"ses_live"}}\n\n', { status: 200 });
  return new Response(JSON.stringify({ healthy: true }), { status: 200 });
};

let base = "";
let server: ReturnType<typeof app.listen>;
before(async () => {
  await resetDb();
  await python();
  setClient(new FakeModelClient(["done"])); // the rewind-runner control test must finish, not call OpenRouter
  settings.opencodeProjectsRoot = mkdtempSync(path.join(os.tmpdir(), "rewind-projects-"));
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await scheduler.waitAll(); setClient(null); await closeDb(); });

test("createSession with the opencode runner starts a recorder", async () => {
  const proj = path.join(settings.opencodeProjectsRoot, "proj");
  mkdirSync(proj);
  writeFileSync(path.join(proj, "x.txt"), "x\n");
  const [repo] = await db.insert(repos).values({ slug: "oc", name: "oc", description: "", bundleKey: "k" }).returning();
  const client = new OpenCodeClient("http://oc", fakeFetch);
  const { branch } = await services.createSession(repo!.id, "t", "do the thing", "deepseek/deepseek-v4-flash", "k", { runner: "opencode", projectDir: proj, ocClient: client });
  assert.equal(branch.runner, "opencode");
  assert.equal(branch.projectDir, proj);
  await runningRecorders().get(branch.id);
  const [b] = await db.select().from(branches).where(eq(branches.id, branch.id));
  assert.equal(b!.ocSessionId, "ses_live");
  assert.equal(b!.status, "done");
  assert.ok(calls.some(([m, p, body]) => m === "POST" && p === "/session/ses_live/prompt_async" && JSON.stringify(body) === JSON.stringify({ parts: [{ type: "text", text: "do the thing" }] })));
  assert.equal(JSON.parse(readFileSync(path.join(proj, "opencode.json"), "utf8")).snapshot, false);
  assert.ok(existsSync(new SnapshotStore("ses_live", proj).gitDir));
});

test("API rejects a project_path outside the projects root, and public callers", async () => {
  const [repo] = await db.insert(repos).values({ slug: "oc2", name: "oc2", description: "", bundleKey: "k" }).returning();
  const body = { repo_id: repo!.id, title: "t", task_prompt: "p", model_id: "deepseek/deepseek-v4-flash", runner: "opencode", project_path: "/definitely/not/here" };
  const post = (b: unknown, headers: Record<string, string>) => fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(b) });
  const r1 = await post(body, { "X-Rewind-Key": "test-key" });
  assert.equal(r1.status, 400);
  assert.match((await r1.json()).detail, /project_path/);
  const r2 = await post(body, {});
  assert.equal(r2.status, 401);
});

test("default runner is unchanged", async () => {
  const [repo] = await db.insert(repos).values({ slug: "r3", name: "r3", description: "", bundleKey: "k" }).returning();
  const r = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json", "X-Rewind-Key": "test-key" }, body: JSON.stringify({ repo_id: repo!.id, title: "t", task_prompt: "p", model_id: "deepseek/deepseek-v4-flash" }) });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).branch.runner, "rewind");
});
