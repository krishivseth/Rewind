/** Every tool_result step of a built-in-loop branch gets a classification, asynchronously. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { asc, eq } from "drizzle-orm";
import { branches, db, sessions, steps } from "@workspace/db";
import { FakeModelClient } from "../src/lib/client";
import { SYSTEM_PROMPT, cheapestModel } from "../src/lib/config";
import { runBranch } from "../src/lib/loop";
import { subscribe, type BranchEvent } from "../src/lib/pubsub";
import { waitPending } from "../src/lib/security/service";
import { closeDb, fakeClassifier, python, resetDb, seedRepo } from "./support";

before(async () => { await resetDb(); await python(); });
after(async () => { await closeDb(); });

test("tool results are classified and published", async () => {
  const fake = fakeClassifier([{ injection: 0.9, effect: "external", effectConf: 1, severity: 4 }]);
  const repo = await seedRepo("csv-stats");
  const [sess] = await db.insert(sessions).values({ repoId: repo.id, title: "c" }).returning();
  const [root] = await db.insert(branches).values({ sessionId: sess!.id, modelId: cheapestModel().id, systemPrompt: SYSTEM_PROMPT, taskPrompt: "t" }).returning();
  const events: BranchEvent[] = [];
  const unsub = subscribe(root!.id, (e) => events.push(e));
  try {
    await runBranch(root!.id, new FakeModelClient([[["run", { command: "test" }]], [["read_file", { path: "csv_stats.py" }]], "done"]));
    await waitPending();
  } finally { unsub(); }
  const rows = await db.select().from(steps).where(eq(steps.branchId, root!.id)).orderBy(asc(steps.stepIndex));
  const results = rows.filter((s) => s.kind === "tool_result");
  assert.equal(results.length, 2);
  assert.equal(results[0]!.classification!.flag, true);
  assert.deepEqual(results[0]!.classification!.reasons, ["injection", "severity"]);
  assert.equal(results[1]!.classification!.flag, false);
  assert.ok(rows.filter((s) => s.kind !== "tool_result").every((s) => s.classification == null));
  assert.ok(fake.states[0]!.startsWith("tool: run\n"));
  const cls = events.filter((e) => e.type === "classification");
  assert.equal(cls.length, 2);
  assert.deepEqual(Object.keys(cls[0]!.data).sort(), ["branch_id", "classification", "index"]);
});
