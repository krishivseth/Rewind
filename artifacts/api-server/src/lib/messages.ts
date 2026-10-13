/** Rebuild the model's message array from step rows, and find valid fork boundaries. */
import type { Step } from "@workspace/db";

export interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }

export type StepLike = Pick<Step, "stepIndex" | "kind" | "content" | "commitHash">;

/**
 * [system] + content of every step except tool_call steps. tool_call rows exist for the scrubber;
 * the assistant row already carries the tool_calls array the model emitted.
 */
export function messagesFromSteps(systemPrompt: string, steps: StepLike[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: systemPrompt }];
  for (const s of [...steps].sort((a, b) => a.stepIndex - b.stepIndex)) {
    if (s.kind === "tool_call") continue;
    out.push({ ...s.content });
  }
  return out;
}

/**
 * Largest index <= stepIndex where the message array is a valid model input: not a tool_call row,
 * and if the trailing assistant turn has tool calls, every one has its result. -1 if none.
 */
export function validBoundary(steps: StepLike[], stepIndex: number): number {
  const ordered = steps.filter((s) => s.stepIndex <= stepIndex).sort((a, b) => a.stepIndex - b.stepIndex);
  while (ordered.length) {
    const last = ordered[ordered.length - 1]!;
    if (last.kind === "tool_call") { ordered.pop(); continue; }
    if (last.kind === "user") return last.stepIndex;
    if (last.kind === "assistant") {
      if ((last.content.tool_calls as unknown[] | undefined)?.length) { ordered.pop(); continue; }
      return last.stepIndex;
    }
    let i = ordered.length - 1;
    while (i >= 0 && ordered[i]!.kind !== "assistant") i -= 1;
    if (i < 0) return last.stepIndex;
    const expected = new Set(((ordered[i]!.content.tool_calls as ToolCall[] | undefined) ?? []).map((c) => c.id));
    const got = new Set(ordered.slice(i + 1).filter((s) => s.kind === "tool_result").map((s) => s.content.tool_call_id as string));
    if ([...expected].every((id) => got.has(id))) return last.stepIndex;
    ordered.splice(i); // partial round: cut it entirely
  }
  return -1;
}

export function lastCommitAtOrBefore(steps: StepLike[], stepIndex: number): string | null {
  for (const s of [...steps].sort((a, b) => b.stepIndex - a.stepIndex)) {
    if (s.stepIndex <= stepIndex && s.commitHash) return s.commitHash;
  }
  return null;
}
