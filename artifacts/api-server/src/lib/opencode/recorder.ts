/**
 * Consume an OpenCode /event stream for one session and write Rewind steps. Snapshots are taken the
 * moment a mutating tool part completes, before the next event is read, so the commit reflects
 * exactly that tool's effect; the round's drafts arrive at step-finish and pick up the hash by callID.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { branches, db, steps, type Step } from "@workspace/db";
import { logger } from "../logger";
import { branchView, stepView } from "../loop";
import { publish } from "../pubsub";
import { scheduleClassification } from "../security/service";
import * as storage from "../storage";
import { branchBundleKey } from "../worktree";
import type { SnapshotStore } from "./snapshots";
import { Translator, type Draft, type OcEvent } from "./translate";

export const MUTATING_OC_TOOLS = new Set(["edit", "write", "bash", "patch", "multiedit"]);

export async function recordStep(branchId: string, draft: Draft, commitHash: string | null, filesChanged: string[]): Promise<Step> {
  const row = await db.transaction(async (tx) => {
    const [b] = await tx.select().from(branches).where(eq(branches.id, branchId)).for("update");
    const [r] = await tx.insert(steps).values({
      branchId, stepIndex: b!.stepCount, kind: draft.kind, content: draft.content,
      toolName: draft.toolName ?? null, toolArgs: draft.toolArgs ?? null, toolResult: draft.toolResult ?? null,
      commitHash, filesChanged, inputTokens: draft.inputTokens, outputTokens: draft.outputTokens,
      ocMessageId: draft.ocMessageId, ocPartId: draft.ocPartId,
    }).returning();
    await tx.update(branches).set({
      stepCount: b!.stepCount + 1,
      totalInputTokens: sql`${branches.totalInputTokens} + ${draft.inputTokens}`,
      totalOutputTokens: sql`${branches.totalOutputTokens} + ${draft.outputTokens}`,
    }).where(eq(branches.id, branchId));
    return r!;
  });
  publish(branchId, { type: "step", data: stepView(row) });
  if (row.kind === "tool_result") scheduleClassification(branchId, row.stepIndex);
  return row;
}

type ToolPart = { sessionID?: string; type: string; tool?: string; callID?: string; state?: { status?: string } };
function completedMutatingTool(e: OcEvent): ToolPart | null {
  if (e.type !== "message.part.updated") return null;
  const part = (e.properties?.part ?? {}) as ToolPart;
  const st = part.state?.status;
  return part.type === "tool" && part.tool && MUTATING_OC_TOOLS.has(part.tool) && (st === "completed" || st === "error") ? part : null;
}

async function finish(branchId: string, status: "done" | "failed", error: string | null, store: SnapshotStore): Promise<void> {
  let bundleKey: string | null = null;
  try {
    if (await store.isDirty()) await store.commit(`final: ${status}`);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "rewind-oc-"));
    try { bundleKey = await storage.putFile(branchBundleKey(branchId), await store.bundle(path.join(tmp, "b.bundle"))); }
    finally { await rm(tmp, { recursive: true, force: true }); }
  } catch (e) {
    logger.error({ err: e, branchId }, "bundle failed");
    error = `${error ?? ""} (bundle failed: ${(e as Error).message})`;
  }
  const [row] = await db.update(branches).set({
    status, error, finishedAt: new Date(), bundleKey, leaseExpiresAt: null, stopReason: status === "done" ? "completed" : "crash",
  }).where(eq(branches.id, branchId)).returning();
  publish(branchId, { type: "status", data: branchView(row!) });
}

export async function recordBranch(branchId: string, events: AsyncIterable<OcEvent>, store: SnapshotStore): Promise<"done" | "failed"> {
  const [b] = await db.select({ oc: branches.ocSessionId }).from(branches).where(eq(branches.id, branchId));
  const t = new Translator(b!.oc!);
  const commits = new Map<string, { hash: string | null; files: string[] }>();
  const seen = new Set<string>();
  try {
    for await (const event of events) {
      const part = completedMutatingTool(event);
      if (part && part.sessionID === b!.oc && part.callID && !seen.has(part.callID)) {
        seen.add(part.callID);
        const hash = await store.commit(`${part.tool} ${part.callID}`);
        commits.set(part.callID, { hash, files: hash ? await store.filesChangedIn(hash) : [] });
      }
      for (const draft of t.feed(event)) {
        const c = draft.kind === "tool_result" && draft.callId ? commits.get(draft.callId) : undefined;
        if (c && draft.callId) commits.delete(draft.callId);
        await recordStep(branchId, draft, c?.hash ?? null, c?.files ?? []);
      }
      if (t.finished) break;
    }
  } catch (e) {
    logger.error({ err: e, branchId }, "recorder crashed");
    await finish(branchId, "failed", `${(e as Error).name}: ${(e as Error).message}`, store);
    return "failed";
  }
  const status = t.finished ?? "failed";
  await finish(branchId, status, status === "failed" ? (t.error ?? "event stream ended") : null, store);
  return status;
}
