/**
 * The handoff a recover-fork reads. Structured fields only: tool names, argument summaries, effect
 * enums, commit hashes, file lists, reason enums. Never tool result text.
 */
import type { Step } from "@workspace/db";

export type LedgerStep = Pick<Step, "stepIndex" | "kind" | "toolName" | "toolArgs" | "commitHash" | "filesChanged" | "classification">;
const ARG_KEYS = ["command", "cmd", "filePath", "path"];

export function summarizeArgs(_toolName: string | null, args: Record<string, unknown> | null): string {
  if (!args) return "";
  for (const k of ARG_KEYS) {
    const v = args[k];
    if (typeof v === "string" && v) return v.length <= 120 ? v : `${v.slice(0, 120)}…`;
  }
  return "";
}

const persistent = (s: LedgerStep) => s.classification?.effect === "external" || (s.classification?.reasons ?? []).includes("egress");

export function buildLedger(boundaryIndex: number, after: LedgerStep[]): string {
  const results = after.filter((s) => s.kind === "tool_result");
  const firstFlag = results.find((s) => s.classification?.flag) ?? null;
  const lines = ["## Rewound", `You were rewound to step ${boundaryIndex}.`];
  if (firstFlag) lines.push(`Reason: step ${firstFlag.stepIndex} (${firstFlag.toolName}) was flagged: ${(firstFlag.classification?.reasons ?? []).join(", ")}.`);
  else lines.push("Reason: none flagged; rewound by the user.");

  const reverted = results.filter((s) => s.commitHash).flatMap((s) => (s.filesChanged ?? []).map((f) => `- ${f} (step ${s.stepIndex})`));
  if (reverted.length) lines.push("", `## Reverted (files restored to step ${boundaryIndex})`, ...reverted);

  const persist = results.filter(persistent).map((s) => `- ${s.toolName}: ${summarizeArgs(s.toolName, s.toolArgs)} (step ${s.stepIndex})`);
  if (persist.length) lines.push("", "## Persistent (could not be reverted)", ...persist);

  const cutoff = firstFlag ? firstFlag.stepIndex : Number.POSITIVE_INFINITY;
  const reusable = results.filter((s) => s.commitHash && s.stepIndex < cutoff)
    .map((s) => `- commit ${s.commitHash}: ${(s.filesChanged ?? []).join(", ")} (its diff is available in Rewind; not applied automatically)`);
  if (reusable.length) lines.push("", "## Reusable work from before the flagged step", ...reusable);
  return `${lines.join("\n")}\n`;
}
