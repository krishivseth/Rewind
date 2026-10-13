/** The agent loop. One function, runBranch, executed as a background task per branch. */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { branches, db, repos, sessions, steps, type Branch, type Step } from "@workspace/db";
import { getClient, type ModelClient } from "./client";
import { estimateCostUsd, settings } from "./config";
import * as git from "./gitwrap";
import { logger } from "./logger";
import { messagesFromSteps, type ToolCall } from "./messages";
import { publish } from "./pubsub";
import * as tools from "./tools";
import * as worktree from "./worktree";

const cancelled = new Set<string>();
export const requestCancel = (id: string) => { cancelled.add(id); };
export const isCancelRequested = (id: string) => cancelled.has(id);

export type StopReason = "completed" | "call_limit" | "loop" | "token_budget" | "wall_clock" | "cancelled" | "provider_error" | "crash";
const SOFT: StopReason[] = ["call_limit", "loop", "token_budget", "wall_clock"];

class BranchStop extends Error {
  constructor(public stop: StopReason, public reason: string) { super(reason); }
}

export function branchView(b: Branch, queuePosition: number | null = null): Record<string, unknown> {
  return {
    id: b.id, session_id: b.sessionId, parent_branch_id: b.parentBranchId, fork_step_index: b.forkStepIndex,
    model_id: b.modelId, task_prompt: b.taskPrompt, status: b.status, error: b.error, stop_reason: b.stopReason, step_count: b.stepCount,
    total_input_tokens: b.totalInputTokens, total_output_tokens: b.totalOutputTokens, bundle_key: b.bundleKey,
    est_cost_usd: Number(estimateCostUsd(b.modelId, b.totalInputTokens, b.totalOutputTokens).toFixed(4)),
    created_at: b.createdAt.toISOString(), finished_at: b.finishedAt?.toISOString() ?? null,
    ...(queuePosition !== null ? { queue_position: queuePosition } : {}),
  };
}

export function stepView(s: Step): Record<string, unknown> {
  return {
    id: s.id, branch_id: s.branchId, index: s.stepIndex, kind: s.kind, content: s.content, tool_name: s.toolName,
    tool_args: s.toolArgs, tool_result: s.toolResult, commit_hash: s.commitHash, files_changed: s.filesChanged ?? [],
    input_tokens: s.inputTokens, output_tokens: s.outputTokens, latency_ms: s.latencyMs, note: s.note,
    created_at: s.createdAt.toISOString(),
  };
}

async function setStatus(branchId: string, status: Branch["status"], opts: { error?: string | null; finished?: boolean; bundleKey?: string | null; stopReason?: StopReason | null } = {}): Promise<Branch> {
  const patch: Partial<Branch> = { status };
  if (opts.error !== undefined) patch.error = opts.error;
  if (opts.stopReason !== undefined) patch.stopReason = opts.stopReason;
  if (opts.finished) { patch.finishedAt = new Date(); patch.leaseExpiresAt = null; }
  else patch.leaseExpiresAt = new Date(Date.now() + settings.leaseSeconds * 1000);
  if (opts.bundleKey) patch.bundleKey = opts.bundleKey;
  const [row] = await db.update(branches).set(patch).where(eq(branches.id, branchId)).returning();
  publish(branchId, { type: "status", data: branchView(row!) });
  return row!;
}

async function recordStep(branchId: string, fields: Omit<typeof steps.$inferInsert, "branchId" | "stepIndex">): Promise<Step> {
  return db.transaction(async (tx) => {
    const [b] = await tx.select().from(branches).where(eq(branches.id, branchId)).for("update");
    const [row] = await tx.insert(steps).values({ ...fields, branchId, stepIndex: b!.stepCount }).returning();
    await tx.update(branches).set({
      stepCount: b!.stepCount + 1,
      totalInputTokens: sql`${branches.totalInputTokens} + ${fields.inputTokens ?? 0}`,
      totalOutputTokens: sql`${branches.totalOutputTokens} + ${fields.outputTokens ?? 0}`,
    }).where(eq(branches.id, branchId));
    publish(branchId, { type: "step", data: stepView(row!) });
    return row!;
  });
}

const shortArgs = (name: string, args: Record<string, unknown>) => String(name === "run" ? args.command ?? "" : args.path ?? "").slice(0, 80);

export async function runBranch(branchId: string, client?: ModelClient): Promise<void> {
  const model = client ?? getClient();
  const started = Date.now();
  let wt: string | null = null;
  let finalStatus: "done" | "failed" | "cancelled" = "failed";
  let finalError: string | null = null;
  let stopReason: StopReason = "crash";
  let wrapUp: ((why: string) => Promise<void>) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;

  try {
    const [branch] = await db.select().from(branches).where(eq(branches.id, branchId));
    if (!branch) throw new Error("branch not found");
    const [sess] = await db.select().from(sessions).where(eq(sessions.id, branch.sessionId));
    const [repo] = await db.select().from(repos).where(eq(repos.id, sess!.repoId));
    if (!repo?.bundleKey) throw new Error("repo has no bundle");
    const parent = branch.parentBranchId ? (await db.select().from(branches).where(eq(branches.id, branch.parentBranchId)))[0] ?? null : null;
    let existing = await db.select().from(steps).where(eq(steps.branchId, branchId)).orderBy(asc(steps.stepIndex));

    if (cancelled.has(branchId)) throw new BranchStop("cancelled", "cancelled before start");
    await setStatus(branchId, "running");
    heartbeat = setInterval(() => {
      db.update(branches).set({ leaseExpiresAt: new Date(Date.now() + settings.leaseSeconds * 1000) })
        .where(and(eq(branches.id, branchId), inArray(branches.status, ["running"]))).catch(() => undefined);
    }, Math.max(10_000, (settings.leaseSeconds * 1000) / 3));

    const startCommit = [...existing].reverse().find((s) => s.commitHash)?.commitHash ?? null;
    wt = await worktree.prepareBranchWorktree(branchId, repo.bundleKey, parent?.bundleKey ?? null, parent?.id ?? null, startCommit);

    if (!existing.length) {
      await recordStep(branchId, { kind: "user", content: { role: "user", content: branch.taskPrompt } });
      existing = await db.select().from(steps).where(eq(steps.branchId, branchId)).orderBy(asc(steps.stepIndex));
    }

    const messages = messagesFromSteps(branch.systemPrompt, existing);
    wrapUp = async (why: string) => {
      const ask = { role: "user", content: `This run is stopping (${why}). Do not call any tools. Reply with a short summary of what you changed, whether the tests pass, and what is left to do.` };
      messages.push(ask);
      await recordStep(branchId, { kind: "user", content: ask });
      const t0 = Date.now();
      const c = await model.complete(branch.modelId, messages, [], settings.maxOutputTokensPerCall);
      const a = c.message as Record<string, unknown>;
      delete a.tool_calls;
      await recordStep(branchId, { kind: "assistant", content: a, inputTokens: c.inputTokens, outputTokens: c.outputTokens, latencyMs: Date.now() - t0 });
    };
    let turns = 0;
    let totalTokens = branch.totalInputTokens + branch.totalOutputTokens;
    let repeats: string[] = [];

    const sessionTokens = async () => {
      const [row] = await db.select({ t: sql<string>`coalesce(sum(${branches.totalInputTokens} + ${branches.totalOutputTokens}), 0)` }).from(branches).where(eq(branches.sessionId, branch.sessionId));
      return Number(row?.t ?? 0);
    };
    const checkLimits = (phase: string) => {
      if (cancelled.has(branchId)) throw new BranchStop("cancelled", `cancelled before ${phase}`);
      if (Date.now() - started > settings.wallClockSecondsPerBranch * 1000) throw new BranchStop("wall_clock", `stopped after ${settings.wallClockSecondsPerBranch}s of wall-clock time`);
      if (totalTokens >= settings.maxTotalTokensPerBranch) throw new BranchStop("token_budget", `stopped at the branch token budget of ${settings.maxTotalTokensPerBranch}`);
    };

    for (;;) {
      checkLimits("model call");
      const isPublic = !!branch.createdBy && (branch.createdBy.startsWith("public:") || branch.createdBy.startsWith("user:"));
      const maxCalls = isPublic ? Math.min(settings.maxModelCalls, settings.publicMaxModelCalls) : settings.maxModelCalls;
      if ((await sessionTokens()) >= settings.maxTotalTokensPerSession) throw new BranchStop("token_budget", `stopped at the session token budget of ${settings.maxTotalTokensPerSession}`);
      // the last allowed call is reserved for the wrap-up
      if (turns >= maxCalls - 1) throw new BranchStop("call_limit", `stopped at the ${maxCalls}-call limit`);
      const t0 = Date.now();
      const completion = await model.complete(branch.modelId, messages, tools.TOOL_SCHEMAS as unknown as unknown[], settings.maxOutputTokensPerCall);
      turns += 1;
      totalTokens += completion.inputTokens + completion.outputTokens;
      const assistant = completion.message as Record<string, unknown>;
      await recordStep(branchId, { kind: "assistant", content: assistant, inputTokens: completion.inputTokens, outputTokens: completion.outputTokens, latencyMs: Date.now() - t0 });
      messages.push(assistant);
      const toolCalls = (assistant.tool_calls as ToolCall[] | undefined) ?? [];
      if (!toolCalls.length) { finalStatus = "done"; stopReason = "completed"; break; }

      for (const tc of toolCalls) {
        checkLimits("tool call");
        const name = tc.function.name;
        let args: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments || "{}");
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("arguments must be an object");
          args = parsed as Record<string, unknown>;
        } catch (e) { args = { _raw: tc.function.arguments }; parseError = `error: could not parse tool arguments: ${(e as Error).message}`; }
        await recordStep(branchId, { kind: "tool_call", content: tc as unknown as Record<string, unknown>, toolName: name, toolArgs: args });

        const t1 = Date.now();
        const outcome = parseError ? { output: parseError, ok: false, mutates: false } : await tools.execute(wt, name, args);
        let commitHash: string | null = null;
        let filesChanged: string[] = [];
        const mutated = (tools.MUTATING_TOOLS.has(name) && outcome.ok) || (outcome.mutates && (await git.isDirty(wt)));
        if (mutated) {
          const [b] = await db.select({ n: branches.stepCount }).from(branches).where(eq(branches.id, branchId));
          commitHash = await git.commitAll(wt, `step ${b!.n}: ${name} ${shortArgs(name, args)}`);
          filesChanged = await git.filesChangedIn(wt, commitHash);
        }

        // same tool, same arguments, back to back: warn, then fail
        const sig = JSON.stringify([name, args]);
        repeats = repeats.length && repeats[repeats.length - 1] === sig ? [...repeats, sig] : [sig];
        let output = outcome.output;
        const record = (o: string) => recordStep(branchId, {
          kind: "tool_result", content: { role: "tool", tool_call_id: tc.id, content: o }, toolName: name, toolArgs: args,
          toolResult: o, commitHash, filesChanged, latencyMs: Date.now() - t1,
        });
        // a call that keeps failing identically gets one fewer chance than one that keeps succeeding
        const failed = !outcome.ok || /exit code: (?!0\b)/.test(outcome.output);
        const failAfter = failed ? Math.max(2, settings.loopFailAfter - 1) : settings.loopFailAfter;
        if (repeats.length >= failAfter) {
          await record(output);
          throw new BranchStop("loop", `stopped: ${name} was called with the same arguments ${repeats.length} times in a row`);
        }
        if (repeats.length >= failAfter - 1) {
          output += `\n\n[rewind] You have made this exact call ${repeats.length} times in a row${failed ? " and it failed each time" : ""}. Repeating it again will end the run. Do something different: read a file you have not read, make an edit, or finish with a summary.`;
        }
        await record(output);
        messages.push({ role: "tool", tool_call_id: tc.id, content: output });
      }
    }
  } catch (e) {
    if (e instanceof BranchStop) {
      stopReason = e.stop;
      finalError = e.reason;
      if (e.stop === "cancelled") finalStatus = "cancelled";
      else if (SOFT.includes(e.stop)) {
        // a soft stop is a pause, not a failure: ask for a summary without tools, then end done
        finalStatus = "done";
        if (wrapUp) { try { await wrapUp(e.reason); } catch (w) { logger.warn({ err: w, branchId }, "wrap-up call failed"); } }
      } else finalStatus = "failed";
    } else {
      const msg = `${(e as Error).name}: ${(e as Error).message}`;
      const provider = /OpenAI|OpenRouter|APIError|status code|402|429|5\d\d/i.test(msg);
      logger.error({ err: e, branchId }, "branch crashed");
      finalStatus = "failed"; finalError = msg; stopReason = provider ? "provider_error" : "crash";
    }
  }

  if (heartbeat) clearInterval(heartbeat);
  let bundleKey: string | null = null;
  try {
    if (wt) {
      if (await git.isDirty(wt)) await git.commitAll(wt, `final: ${finalStatus}`, false);
      bundleKey = await worktree.finalizeBranch(branchId);
    }
  } catch (e) {
    logger.error({ err: e, branchId }, "finalize failed");
    finalError = `${finalError ?? ""} (finalize failed: ${(e as Error).message})`;
  }
  const row = await setStatus(branchId, finalStatus, { error: finalError, finished: true, bundleKey, stopReason });
  cancelled.delete(branchId);
  logger.info({
    branchId, status: finalStatus, model: row.modelId, steps: row.stepCount, tokensIn: row.totalInputTokens, tokensOut: row.totalOutputTokens,
    estCostUsd: Number(estimateCostUsd(row.modelId, row.totalInputTokens, row.totalOutputTokens).toFixed(4)),
    elapsedS: Number(((Date.now() - started) / 1000).toFixed(1)), reason: finalError ?? undefined,
  }, "branch finished");
}
