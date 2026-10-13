/** Phase 1 acceptance test: record, bundle, restore, fork, all with a scripted fake model. */
import "./setup";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq } from "drizzle-orm";
import { branches, db, sessions, steps } from "@workspace/db";
import { FakeModelClient, type ScriptTurn } from "../src/lib/client";
import { SYSTEM_PROMPT, cheapestModel, settings } from "../src/lib/config";
import { createForks } from "../src/lib/fork";
import * as git from "../src/lib/gitwrap";
import { runBranch } from "../src/lib/loop";
import { lastCommitAtOrBefore, messagesFromSteps } from "../src/lib/messages";
import * as worktree from "../src/lib/worktree";
import { closeDb, python, resetDb, seedRepo } from "./support";

const AT3 = "# notes v1\nwritten at tool call 3\n";
const AT5 = "# notes v2\nwritten at tool call 5\n";
const SCRIPT: ScriptTurn[] = [
  [["read_file", { path: "csv_stats.py" }]],
  [["run", { command: "test" }]],
  [["write_file", { path: "NOTES.md", content: AT3 }]],
  [["read_file", { path: "tests/test_csv_stats.py" }]],
  [["edit_file", { path: "NOTES.md", old_string: AT3, new_string: AT5 }]],
  [["read_file", { path: "NOTES.md" }]],
  "All done.",
];

before(async () => { await resetDb(); await python(); });
after(async () => { await closeDb(); });

const loadSteps = (id: string) => db.select().from(steps).where(eq(steps.branchId, id)).orderBy(asc(steps.stepIndex));
const loadBranch = async (id: string) => (await db.select().from(branches).where(eq(branches.id, id)))[0]!;

test("roundtrip: record, bundle, restore, fork", async () => {
  const repo = await seedRepo("csv-stats");
  const [sess] = await db.insert(sessions).values({ repoId: repo.id, title: "roundtrip" }).returning();
  const [root] = await db.insert(branches).values({ sessionId: sess!.id, modelId: cheapestModel().id, systemPrompt: SYSTEM_PROMPT, taskPrompt: "Make all tests pass" }).returning();
  await db.update(sessions).set({ rootBranchId: root!.id }).where(eq(sessions.id, sess!.id));

  const fake = new FakeModelClient([...SCRIPT]);
  await runBranch(root!.id, fake);
  const branch = await loadBranch(root!.id);
  assert.equal(branch.status, "done", branch.error ?? "");
  const rows = await loadSteps(root!.id);
  const results = rows.filter((s) => s.kind === "tool_result");
  assert.equal(results.length, 6);
  assert.equal(rows[0]!.kind, "user");
  assert.equal(branch.stepCount, 1 + 6 * 3 + 1);

  assert.equal(results[2]!.toolName, "write_file");
  assert.equal(results[4]!.toolName, "edit_file");
  for (const r of [results[2]!, results[4]!]) { assert.equal(r.commitHash?.length, 40); assert.deepEqual(r.filesChanged, ["NOTES.md"]); }
  for (const r of [results[0]!, results[3]!, results[5]!]) { assert.equal(r.commitHash, null); assert.deepEqual(r.filesChanged, []); }
  assert.match(results[1]!.toolResult!, /exit code/);
  assert.match(results[1]!.toolResult!, /2 failed/);
  assert.equal(fake.calls.at(-1)!.at(-1)!.content, AT5);

  // bundle exists, worktree deleted; restore and compare step 3 vs step 5
  assert.equal(branch.bundleKey, `bundles/${root!.id}.bundle`);
  assert.ok(existsSync(path.join(settings.dataDir, "storage", branch.bundleKey!)));
  assert.ok(!existsSync(worktree.branchDir(root!.id)));
  const restored = await worktree.restoredRepo(root!.id, branch.bundleKey);
  const c3 = results[2]!.commitHash!, c5 = results[4]!.commitHash!;
  await git.git(restored, ["checkout", "-q", c3]);
  assert.equal(readFileSync(path.join(restored, "NOTES.md"), "utf8"), AT3);
  assert.equal((await git.showFile(restored, c3, "NOTES.md")).toString(), AT3);
  assert.equal((await git.showFile(restored, c5, "NOTES.md")).toString(), AT5);

  // fork at step 3's tool_result with count 2
  const forkAt = results[2]!.stepIndex;
  assert.equal(lastCommitAtOrBefore(rows, forkAt), c3);
  const ids = await createForks(root!.id, forkAt, cheapestModel().id, null, 2, null);
  assert.equal(ids.length, 2);
  for (const id of ids) {
    const fb = await loadBranch(id);
    assert.equal(fb.parentBranchId, root!.id);
    assert.equal(fb.forkStepIndex, forkAt);
    const inherited = await loadSteps(id);
    assert.deepEqual(inherited.map((s) => s.stepIndex), [...Array(forkAt + 1).keys()]);
    assert.equal(inherited.at(-1)!.commitHash, c3);
    assert.deepEqual(messagesFromSteps(SYSTEM_PROMPT, inherited), messagesFromSteps(SYSTEM_PROMPT, rows.slice(0, forkAt + 1)));
  }
  const clients = ids.map(() => new FakeModelClient([[["write_file", { path: "FORK.md", content: "fork\n" }]], "done"]));
  await Promise.all(ids.map((id, i) => runBranch(id, clients[i]!)));
  for (const [i, id] of ids.entries()) {
    const fb = await loadBranch(id);
    assert.equal(fb.status, "done", fb.error ?? "");
    assert.deepEqual(clients[i]!.calls[0], messagesFromSteps(SYSTEM_PROMPT, rows.slice(0, forkAt + 1)));
    const fresh = (await loadSteps(id)).find((s) => s.kind === "tool_result" && s.stepIndex > forkAt)!;
    assert.deepEqual(fresh.filesChanged, ["FORK.md"]);
    const r = await worktree.restoredRepo(id, fb.bundleKey);
    assert.equal((await git.git(r, ["rev-parse", `${fresh.commitHash}^`])).trim(), c3);
    assert.equal((await git.git(r, ["log", "-1", "--format=%an <%ae>", fresh.commitHash!])).trim(), "Rewind <rewind@localhost>");
  }
});
