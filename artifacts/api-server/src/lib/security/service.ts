/** Classify one recorded tool_result step and store the verdict on it. */
import { and, eq } from "drizzle-orm";
import { branches, db, steps, type Classification } from "@workspace/db";
import { settings } from "../config";
import { logger } from "../logger";
import { publish } from "../pubsub";
import { getClassifier, renderState, verdict } from "./classify";
import { ruleReasons } from "./rules";

const pending = new Set<Promise<unknown>>();

export async function classifyStep(branchId: string, index: number): Promise<Classification | null> {
  const [step] = await db.select().from(steps).where(and(eq(steps.branchId, branchId), eq(steps.stepIndex, index)));
  if (!step || step.kind !== "tool_result") return null;
  const [branch] = await db.select({ projectDir: branches.projectDir }).from(branches).where(eq(branches.id, branchId));
  const rules = ruleReasons(step.toolName ?? "", step.toolArgs, step.toolResult, branch?.projectDir ?? null);
  const decision = await getClassifier().decide(renderState(step.toolName ?? "", step.toolArgs, step.toolResult, settings.classifyMaxChars));
  const v: Classification = { ...verdict(rules, decision), source: "posthoc" };
  await db.update(steps).set({ classification: v }).where(eq(steps.id, step.id));
  publish(branchId, { type: "classification", data: { branch_id: branchId, index, classification: v } });
  return v;
}

export function scheduleClassification(branchId: string, index: number): void {
  const p: Promise<unknown> = classifyStep(branchId, index)
    .catch((e: unknown) => { logger.error({ err: e, branchId, index }, "classification failed"); })
    .finally(() => { pending.delete(p); });
  pending.add(p);
}

/** Test helper: await every scheduled classification. */
export async function waitPending(): Promise<void> {
  while (pending.size) await Promise.allSettled([...pending]);
}
