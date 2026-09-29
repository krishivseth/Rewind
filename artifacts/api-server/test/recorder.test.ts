/** Replay the fixture through the recorder against a real project dir and DB. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { branches, db, repos, sessions, steps } from "@workspace/db";
import { recordBranch } from "../src/lib/opencode/recorder";
import { SnapshotStore } from "../src/lib/opencode/snapshots";
import { readFixtureEvents, type OcEvent } from "../src/lib/opencode/translate";
import { waitPending } from "../src/lib/security/service";
import { closeDb, resetDb, SEED_DIR, settings } from "./support";

export const FIXTURE = path.join(process.cwd(), "test/fixtures/opencode_events.jsonl");
export const MAIN = "ses_f1540231effe4QkaJiFInzILu8";

before(async () => { await resetDb(); });
after(async () => { await closeDb(); });

export async function makeBranch(projectDir: string, ocSessionId = MAIN) {
  const [repo] = await db.insert(repos).values({ slug: `oc-${Math.random().toString(36).slice(2, 8)}`, name: "oc", description: "", bundleKey: "k" }).returning();
  const [sess] = await db.insert(sessions).values({ repoId: repo!.id, title: "oc" }).returning();
  const [b] = await db.insert(branches).values({
    sessionId: sess!.id, modelId: "deepseek/deepseek-v4-flash", taskPrompt: "t", status: "running",
    runner: "opencode", ocSessionId, projectDir,
  }).returning();
  await db.update(sessions).set({ rootBranchId: b!.id }).where(eq(sessions.id, sess!.id));
  return b!.id;
}
export async function* fixtureEvents(): AsyncGenerator<OcEvent> { for (const e of readFixtureEvents(FIXTURE)) yield e; }

test("fixture replay records steps and finishes", async () => {
  const proj = path.join(mkdtempSync(path.join(os.tmpdir(), "rewind-rec-")), "proj");
  cpSync(path.join(SEED_DIR, "csv-stats"), proj, { recursive: true });
  const bid = await makeBranch(proj);
  const store = new SnapshotStore(MAIN, proj);
  await store.init();
  const status = await recordBranch(bid, fixtureEvents(), store);
  await waitPending();
  assert.equal(status, "done");
  const rows = await db.select().from(steps).where(eq(steps.branchId, bid)).orderBy(asc(steps.stepIndex));
  const [b] = await db.select().from(branches).where(eq(branches.id, bid));
  assert.equal(rows.length, 28);
  assert.deepEqual(rows.map((s) => s.stepIndex), [...Array(28).keys()]);
  assert.equal(b!.status, "done");
  assert.equal(b!.stepCount, 28);
  assert.ok(b!.finishedAt);
  assert.ok(b!.totalInputTokens > 0);
  assert.equal(b!.bundleKey, `bundles/${bid}.bundle`);
  assert.ok(existsSync(path.join(settings.dataDir, "storage", b!.bundleKey!)));
  const results = rows.filter((s) => s.kind === "tool_result");
  assert.ok(results.every((s) => s.ocMessageId && s.ocPartId));
  assert.ok(results.every((s) => s.classification !== null));
});

test("a mutating tool gets a commit when files change", async () => {
  const proj = path.join(mkdtempSync(path.join(os.tmpdir(), "rewind-rec-")), "proj");
  mkdirSync(proj);
  writeFileSync(path.join(proj, "f.txt"), "a\n");
  const bid = await makeBranch(proj, "s1");
  const store = new SnapshotStore("s1", proj);
  await store.init();
  const part = (id: string, extra: Record<string, unknown>): OcEvent => ({ type: "message.part.updated", properties: { part: { id, messageID: "m1", sessionID: "s1", ...extra } } });
  async function* events(): AsyncGenerator<OcEvent> {
    yield { type: "message.updated", properties: { info: { id: "m0", role: "user", sessionID: "s1" } } };
    yield { type: "message.part.updated", properties: { part: { id: "p0", messageID: "m0", sessionID: "s1", type: "text", text: "go" } } };
    yield { type: "message.updated", properties: { info: { id: "m1", role: "assistant", sessionID: "s1" } } };
    yield part("p1", { type: "step-start" });
    yield part("p2", { type: "tool", tool: "edit", callID: "c1", state: { status: "running", input: { filePath: `${proj}/f.txt` } } });
    writeFileSync(path.join(proj, "f.txt"), "b\n"); // the tool's effect
    yield part("p2", { type: "tool", tool: "edit", callID: "c1", state: { status: "completed", input: { filePath: `${proj}/f.txt` }, output: "ok" } });
    yield part("p3", { type: "step-finish", reason: "stop", tokens: { input: 5, output: 2, reasoning: 0 } });
    yield { type: "session.idle", properties: { sessionID: "s1" } };
  }
  await recordBranch(bid, events(), store);
  const rows = await db.select().from(steps).where(eq(steps.branchId, bid)).orderBy(asc(steps.stepIndex));
  const result = rows.find((s) => s.kind === "tool_result")!;
  assert.ok(result.commitHash);
  assert.deepEqual(result.filesChanged, ["f.txt"]);
  assert.deepEqual(await store.filesChangedIn(result.commitHash!), ["f.txt"]);
});
