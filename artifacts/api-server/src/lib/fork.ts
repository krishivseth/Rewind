/** Fork semantics: slice the parent's steps to a valid boundary, copy them, return new ids (not started). */
import { asc, eq } from "drizzle-orm";
import { branches, db, steps } from "@workspace/db";
import { validBoundary } from "./messages";

export async function createForks(parentId: string, stepIndex: number, modelId: string, editedTaskPrompt: string | null, count: number, createdBy: string | null): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(branches).where(eq(branches.id, parentId));
    if (!parent) throw new Error("parent branch not found");
    const rows = await tx.select().from(steps).where(eq(steps.branchId, parentId)).orderBy(asc(steps.stepIndex));
    if (!rows.length) throw new RangeError("parent has no steps yet");
    if (stepIndex < 0 || stepIndex >= rows.length) throw new RangeError(`step_index must be in 0..${rows.length - 1}`);
    const boundary = validBoundary(rows, stepIndex);
    if (boundary < 0) throw new RangeError("no valid fork boundary at or before that step");
    const inherited = rows.filter((s) => s.stepIndex <= boundary);
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const [child] = await tx.insert(branches).values({
        sessionId: parent.sessionId, parentBranchId: parent.id, forkStepIndex: boundary, modelId,
        systemPrompt: parent.systemPrompt, taskPrompt: editedTaskPrompt ?? parent.taskPrompt, status: "queued",
        stepCount: inherited.length, createdBy,
      }).returning();
      if (inherited.length) {
        await tx.insert(steps).values(inherited.map((s) => ({
          branchId: child!.id, stepIndex: s.stepIndex, kind: s.kind,
          content: s.stepIndex === 0 && s.kind === "user" && editedTaskPrompt !== null ? { ...s.content, content: editedTaskPrompt } : s.content,
          toolName: s.toolName, toolArgs: s.toolArgs, toolResult: s.toolResult, commitHash: s.commitHash, filesChanged: s.filesChanged,
          inputTokens: 0, outputTokens: 0, latencyMs: s.latencyMs, note: s.note,
        })));
      }
      ids.push(child!.id);
    }
    return ids;
  });
}
