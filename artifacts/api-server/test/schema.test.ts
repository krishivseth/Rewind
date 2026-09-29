/** New columns round-trip and appear in the views. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { branches, db, repos, sessions, steps } from "@workspace/db";
import { branchView, stepView } from "../src/lib/loop";
import { closeDb, resetDb } from "./support";

before(async () => { await resetDb(); });
after(async () => { await closeDb(); });

test("runner, opencode ids and classification round-trip", async () => {
  const [repo] = await db.insert(repos).values({ slug: "r", name: "r", description: "", bundleKey: "k" }).returning();
  const [sess] = await db.insert(sessions).values({ repoId: repo!.id, title: "t" }).returning();
  const [b] = await db.insert(branches).values({
    sessionId: sess!.id, modelId: "m", taskPrompt: "p", runner: "opencode", ocSessionId: "ses_1", projectDir: "/tmp/p",
  }).returning();
  const [s] = await db.insert(steps).values({
    branchId: b!.id, stepIndex: 0, kind: "tool_result", content: { role: "tool" },
    ocMessageId: "msg_1", ocPartId: "prt_1",
    classification: { flag: true, reasons: ["egress"], injection: 0.1, effect: "external", effect_conf: 1, severity: 3.5 },
  }).returning();
  const bv = branchView(b!);
  assert.equal(bv.runner, "opencode");
  assert.equal(bv.oc_session_id, "ses_1");
  assert.equal(bv.project_dir, "/tmp/p");
  const sv = stepView(s!);
  assert.equal(sv.oc_message_id, "msg_1");
  assert.equal(sv.oc_part_id, "prt_1");
  assert.deepEqual((sv.classification as { reasons: string[] }).reasons, ["egress"]);
  const [again] = await db.select().from(branches).where(eq(branches.id, b!.id));
  assert.equal(again!.runner, "opencode");
});

test("default runner is rewind and classification is null", async () => {
  const [repo] = await db.insert(repos).values({ slug: "r2", name: "r2", description: "", bundleKey: "k" }).returning();
  const [sess] = await db.insert(sessions).values({ repoId: repo!.id, title: "t" }).returning();
  const [b] = await db.insert(branches).values({ sessionId: sess!.id, modelId: "m", taskPrompt: "p" }).returning();
  assert.equal(branchView(b!).runner, "rewind");
  const [s] = await db.insert(steps).values({ branchId: b!.id, stepIndex: 0, kind: "user", content: {} }).returning();
  assert.equal(stepView(s!).classification, null);
});
