/** Start recording an OpenCode session for a branch, and fork one in either mode. */
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { asc, eq } from "drizzle-orm";
import { branches, db, steps } from "@workspace/db";
import { logger } from "../logger";
import { lastCommitAtOrBefore, validBoundary } from "../messages";
import { buildLedger } from "../security/ledger";
import { manager, writeOpencodeConfig, type OpenCodeClient } from "./client";
import { recordBranch } from "./recorder";
import { SnapshotStore } from "./snapshots";
import type { OcEvent } from "./translate";

const recorders = new Map<string, Promise<unknown>>();
export function runningRecorders(): Map<string, Promise<unknown>> { return recorders; }

/** Open the event stream before prompting so the first events are never missed. */
export async function openedStream(client: OpenCodeClient): Promise<AsyncIterable<OcEvent>> {
  const it = client.events()[Symbol.asyncIterator]();
  const first = await it.next();
  return {
    async *[Symbol.asyncIterator]() {
      if (!first.done) yield first.value;
      for (;;) { const n = await it.next(); if (n.done) return; yield n.value; }
    },
  };
}

export function track(branchId: string, run: () => Promise<unknown>): void {
  const p = run()
    .catch((e: unknown) => { logger.error({ err: e, branchId }, "opencode recorder failed"); })
    .finally(() => { recorders.delete(branchId); });
  recorders.set(branchId, p);
}

export async function startOpencodeBranch(branchId: string, client?: OpenCodeClient): Promise<void> {
  const [b] = await db.select().from(branches).where(eq(branches.id, branchId));
  if (!b?.projectDir) throw new Error("branch has no project_dir");
  await writeOpencodeConfig(b.projectDir, b.modelId);
  const oc = client ?? (await manager().ensure(b.projectDir));
  const ocId = await oc.createSession(`rewind ${branchId.slice(0, 8)}`);
  const store = new SnapshotStore(ocId, b.projectDir);
  await store.init();
  await db.update(branches).set({ ocSessionId: ocId, status: "running" }).where(eq(branches.id, branchId));
  const stream = await openedStream(oc);
  track(branchId, async () => {
    await oc.promptAsync(ocId, b.taskPrompt);
    await recordBranch(branchId, stream, store);
  });
}

/**
 * Fork an OpenCode branch at a step. The transcript comes from OpenCode's own fork (which copies
 * every message *before* the given id); the files come from Rewind's snapshots. "investigate"
 * continues blind; "recover" sends the ledger of what the parent did after the boundary.
 *
 * validBoundary only ever returns a complete round, and a round is one OpenCode message, so forking
 * before the *next* message is exact and revert-by-part is not needed.
 */
export async function forkOpencodeBranch(parentId: string, stepIndex: number, mode: "investigate" | "recover", createdBy: string | null, client?: OpenCodeClient): Promise<string> {
  const [parent] = await db.select().from(branches).where(eq(branches.id, parentId));
  if (!parent || parent.runner !== "opencode" || !parent.ocSessionId || !parent.projectDir) throw new RangeError("not an OpenCode branch");
  const rows = await db.select().from(steps).where(eq(steps.branchId, parentId)).orderBy(asc(steps.stepIndex));
  if (!rows.length) throw new RangeError("parent has no steps yet");
  if (stepIndex < 0 || stepIndex >= rows.length) throw new RangeError(`step_index must be in 0..${rows.length - 1}`);
  const boundary = validBoundary(rows, stepIndex);
  if (boundary < 0) throw new RangeError("no valid fork boundary at or before that step");
  const at = rows[boundary]!;
  // when nothing follows the boundary we fork before the last message and let the fork re-run that round
  const following = rows.find((s) => s.stepIndex > boundary && s.ocMessageId !== at.ocMessageId);
  const forkAt = following?.ocMessageId ?? at.ocMessageId!;

  const oc = client ?? (await manager().ensure(parent.projectDir));
  const ocFork = await oc.fork(parent.ocSessionId, forkAt);

  const parentStore = new SnapshotStore(parent.ocSessionId, parent.projectDir);
  const store = new SnapshotStore(ocFork, parent.projectDir);
  if (existsSync(parentStore.gitDir)) await cp(parentStore.gitDir, store.gitDir, { recursive: true });
  else await store.init();
  await store.checkout(lastCommitAtOrBefore(rows, boundary) ?? (await store.rootCommit()));

  const inherited = rows.filter((s) => s.stepIndex <= boundary);
  const childId = await db.transaction(async (tx) => {
    const [child] = await tx.insert(branches).values({
      sessionId: parent.sessionId, parentBranchId: parent.id, forkStepIndex: boundary, modelId: parent.modelId,
      systemPrompt: parent.systemPrompt, taskPrompt: parent.taskPrompt, status: "running", stepCount: inherited.length, createdBy,
      runner: "opencode", ocSessionId: ocFork, projectDir: parent.projectDir,
    }).returning();
    await tx.insert(steps).values(inherited.map((s) => ({
      branchId: child!.id, stepIndex: s.stepIndex, kind: s.kind, content: s.content, toolName: s.toolName, toolArgs: s.toolArgs,
      toolResult: s.toolResult, commitHash: s.commitHash, filesChanged: s.filesChanged, inputTokens: 0, outputTokens: 0,
      latencyMs: s.latencyMs, note: s.note, ocMessageId: s.ocMessageId, ocPartId: s.ocPartId, classification: s.classification,
    })));
    return child!.id;
  });

  const text = mode === "recover" ? buildLedger(boundary, rows.filter((s) => s.stepIndex > boundary)) : null;
  const stream = await openedStream(oc);
  track(childId, async () => {
    await oc.promptAsync(ocFork, text);
    await recordBranch(childId, stream, store);
  });
  return childId;
}
