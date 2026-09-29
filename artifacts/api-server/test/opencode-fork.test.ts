/** Fork an OpenCode branch: transcript via the server, files via our snapshots, ledger on recover. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { branches, db, repos, sessions, steps } from "@workspace/db";
import { OpenCodeClient } from "../src/lib/opencode/client";
import { recordBranch } from "../src/lib/opencode/recorder";
import { forkOpencodeBranch, runningRecorders } from "../src/lib/opencode/session";
import { SnapshotStore } from "../src/lib/opencode/snapshots";
import { readFixtureEvents, type OcEvent } from "../src/lib/opencode/translate";
import { closeDb, resetDb, SEED_DIR } from "./support";

const FIXTURE = path.join(process.cwd(), "test/fixtures/opencode_events.jsonl");
const MAIN = "ses_f1540231effe4QkaJiFInzILu8";

before(async () => { await resetDb(); });
after(async () => { await closeDb(); });

async function makeBranch(projectDir: string) {
  const [repo] = await db.insert(repos).values({ slug: `oc-${Math.random().toString(36).slice(2, 8)}`, name: "oc", description: "", bundleKey: "k" }).returning();
  const [sess] = await db.insert(sessions).values({ repoId: repo!.id, title: "oc" }).returning();
  const [b] = await db.insert(branches).values({ sessionId: sess!.id, modelId: "deepseek/deepseek-v4-flash", taskPrompt: "t", status: "running", runner: "opencode", ocSessionId: MAIN, projectDir }).returning();
  await db.update(sessions).set({ rootBranchId: b!.id }).where(eq(sessions.id, sess!.id));
  return b!.id;
}
async function* fixtureEvents(): AsyncGenerator<OcEvent> { for (const e of readFixtureEvents(FIXTURE)) yield e; }

function forkServer() {
  const calls: Array<[string, string, unknown]> = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const p = new URL(String(url)).pathname;
    calls.push([init?.method ?? "GET", p, init?.body ? JSON.parse(String(init.body)) : null]);
    if (p.endsWith("/fork")) return new Response(JSON.stringify({ id: "ses_fork" }), { status: 200 });
    if (p.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    if (p === "/event") return new Response('data: {"type":"server.connected","properties":{}}\n\ndata: {"type":"session.idle","properties":{"sessionID":"ses_fork"}}\n\n', { status: 200 });
    return new Response("{}", { status: 200 });
  };
  return { calls, client: new OpenCodeClient("http://oc", fetchImpl) };
}

async function recordedParent() {
  const proj = path.join(mkdtempSync(path.join(os.tmpdir(), "rewind-fork-")), "proj");
  cpSync(path.join(SEED_DIR, "csv-stats"), proj, { recursive: true });
  const bid = await makeBranch(proj);
  const store = new SnapshotStore(MAIN, proj);
  await store.init();
  await recordBranch(bid, fixtureEvents(), store);
  return { bid, proj, store };
}
const loadSteps = (id: string) => db.select().from(steps).where(eq(steps.branchId, id)).orderBy(asc(steps.stepIndex));

test("investigate fork uses the next message and an empty prompt", async () => {
  const { bid, proj } = await recordedParent();
  const { calls, client } = forkServer();
  // step 5 is the last tool_result of round 1 (0 user, 1 assistant, 2/3, 4/5)
  const child = await forkOpencodeBranch(bid, 5, "investigate", "k", client);
  await runningRecorders().get(child);
  const [c] = await db.select().from(branches).where(eq(branches.id, child));
  const rows = await loadSteps(child);
  assert.equal(c!.parentBranchId, bid);
  assert.equal(c!.forkStepIndex, 5);
  assert.equal(c!.runner, "opencode");
  assert.equal(c!.ocSessionId, "ses_fork");
  assert.equal(c!.projectDir, proj);
  assert.deepEqual(rows.slice(0, 6).map((s) => s.stepIndex), [0, 1, 2, 3, 4, 5]);
  assert.equal(rows[5]!.ocPartId, "prt_0eabff149001qfJPUnCd1Mo4P7");
  assert.deepEqual(calls.find(([, p]) => p.endsWith("/fork")), ["POST", `/session/${MAIN}/fork`, { messageID: "msg_0eabff427001X5KrGbzF6JIOSk" }]);
  assert.deepEqual(calls.find(([, p]) => p.endsWith("/prompt_async"))![2], { parts: [] });
  assert.ok(!calls.some(([, p]) => p.endsWith("/revert")));
  assert.ok(existsSync(new SnapshotStore("ses_fork", proj).gitDir));
});

test("recover fork sends the ledger and restores files", async () => {
  const { bid, proj, store } = await recordedParent();
  const rows = await loadSteps(bid);
  writeFileSync(path.join(proj, "NOTE.md"), "at step 5\n");
  const c5 = (await store.commit("step 5"))!;
  await db.update(steps).set({ commitHash: c5, filesChanged: ["NOTE.md"] }).where(eq(steps.id, rows[5]!.id));
  assert.equal(rows[8]!.toolName, "bash"); // round 2's result
  await db.update(steps).set({ classification: { flag: true, reasons: ["egress"], effect: "external", injection: 0.1, effect_conf: 1, severity: 3.5 } }).where(eq(steps.id, rows[8]!.id));
  writeFileSync(path.join(proj, "NOTE.md"), "changed later\n");
  writeFileSync(path.join(proj, "junk.txt"), "later\n");
  const { calls, client } = forkServer();
  const child = await forkOpencodeBranch(bid, 5, "recover", "k", client);
  await runningRecorders().get(child);
  assert.equal(readFileSync(path.join(proj, "NOTE.md"), "utf8"), "at step 5\n");
  assert.ok(!existsSync(path.join(proj, "junk.txt")));
  const text = (calls.find(([, p]) => p.endsWith("/prompt_async"))![2] as { parts: Array<{ text: string }> }).parts[0]!.text;
  assert.ok(text.startsWith("## Rewound\nYou were rewound to step 5."));
  assert.ok(text.includes("## Persistent") && text.includes("bash:"));
  assert.ok(!text.includes("<path>")); // no tool output leaked
});

test("fork snaps to a round boundary", async () => {
  const { bid } = await recordedParent();
  const { calls, client } = forkServer();
  const child = await forkOpencodeBranch(bid, 2, "investigate", "k", client); // a tool_call row
  await runningRecorders().get(child);
  const [c] = await db.select().from(branches).where(eq(branches.id, child));
  assert.equal(c!.forkStepIndex, 0); // only the user message is a complete boundary before index 2
  assert.deepEqual(calls.find(([, p]) => p.endsWith("/fork"))![2], { messageID: "msg_0eabfddef001whoxmgqVivmwDR" });
});
