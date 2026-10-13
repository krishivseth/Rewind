/** Application services shared by routes, the seed script and tests. */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { branches, bundleCleanupQueue, db, repos, sessions, steps, type Branch, type Repo, type Session, type Step } from "@workspace/db";
import { SYSTEM_PROMPT, settings } from "./config";
import * as git from "./gitwrap";
import { logger } from "./logger";
import { requestCancel } from "./loop";
import { sandboxPythonStatus } from "./sandbox-python";
import { lastCommitAtOrBefore, messagesFromSteps } from "./messages";
import * as scheduler from "./scheduler";
import * as storage from "./storage";
import * as worktree from "./worktree";

const DESCRIPTIONS: Record<string, string> = {
  "tiny-todo": "Flask todo API with an in-memory store and pytest tests.",
  "csv-stats": "CLI that prints CSV column statistics. Two bugs, two failing tests.",
  "rate-limiter": "Thread-safe token bucket with a concurrency bug and a failing test.",
  blank: "Empty Python project with pytest. Start from nothing.",
};

/** Bundle every directory under seed_repos/ into storage and register it, if missing. */
export async function ensureSeedRepos(): Promise<Repo[]> {
  const out: Repo[] = [];
  let entries: string[];
  try { entries = (await readdir(settings.seedReposDir)).sort(); } catch { return out; }
  for (const slug of entries) {
    const dir = path.join(settings.seedReposDir, slug);
    if (!(await stat(dir)).isDirectory()) continue;
    let [repo] = await db.select().from(repos).where(eq(repos.slug, slug));
    if (!repo || !repo.bundleKey || !(await storage.exists(repo.bundleKey))) {
      const key = await worktree.createRepoBundle(slug, dir);
      if (!repo) [repo] = await db.insert(repos).values({ slug, name: slug, description: DESCRIPTIONS[slug] ?? "", bundleKey: key }).returning();
      else [repo] = await db.update(repos).set({ bundleKey: key }).where(eq(repos.id, repo.id)).returning();
      logger.info({ slug, key }, "seeded repo");
    }
    out.push(repo!);
  }
  return out;
}

/** Branches whose lease expired were owned by a process that died; fail them, bundling any surviving worktree. */
export async function recoverStaleBranches(all = false): Promise<number> {
  const rows = await db.select().from(branches).where(and(
    inArray(branches.status, ["running", "queued"]),
    all ? sql`true` : or(isNull(branches.leaseExpiresAt), sql`${branches.leaseExpiresAt} < now()`),
  ));
  for (const b of rows) {
    if (!all && scheduler.isTracked(b.id)) continue;
    let bundleKey = b.bundleKey;
    if (!bundleKey) {
      try {
        const wt = worktree.branchDir(b.id);
        if (await git.isDirty(wt).catch(() => false)) await git.commitAll(wt, "final: recovered", false);
        bundleKey = await worktree.finalizeBranch(b.id);
      } catch (e) { logger.warn({ err: e, branchId: b.id }, "could not finalize stale branch"); }
    }
    await db.update(branches).set({ status: "failed", error: "server restarted while branch was in progress", finishedAt: new Date(), leaseExpiresAt: null, bundleKey })
      .where(eq(branches.id, b.id));
  }
  return rows.length;
}

export async function createSession(repoId: string, title: string, taskPrompt: string, modelId: string, createdBy: string | null): Promise<{ session: Session; branch: Branch }> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, repoId));
  if (!repo) throw new Error("repo not found");
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.insert(sessions).values({ repoId, title }).returning();
    const [branch] = await tx.insert(branches).values({ sessionId: session!.id, modelId, systemPrompt: SYSTEM_PROMPT, taskPrompt, status: "queued", createdBy }).returning();
    const [updated] = await tx.update(sessions).set({ rootBranchId: branch!.id }).where(eq(sessions.id, session!.id)).returning();
    return { session: updated!, branch: branch! };
  });
  void scheduler.enqueue(result.branch.id);
  return result;
}

export async function tokensUsedToday(): Promise<number> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const [row] = await db.select({ total: sql<string>`coalesce(sum(${branches.totalInputTokens} + ${branches.totalOutputTokens}), 0)` }).from(branches).where(gte(branches.createdAt, start));
  return Number(row?.total ?? 0);
}

export const branchSteps = (branchId: string) => db.select().from(steps).where(eq(steps.branchId, branchId)).orderBy(asc(steps.stepIndex));
export const getBranch = async (id: string): Promise<Branch | null> => (await db.select().from(branches).where(eq(branches.id, id)))[0] ?? null;

// --- git views -----------------------------------------------------------------------------

const repoDirFor = (b: Branch) => worktree.restoredRepo(b.id, b.bundleKey);

async function commitForStep(repoDir: string, rows: Step[], index: number): Promise<string> {
  return lastCommitAtOrBefore(rows, index) ?? (await git.rootCommit(repoDir));
}

function stepAt(rows: Step[], index: number): Step {
  const s = rows.find((r) => r.stepIndex === index);
  if (!s) throw new RangeError(`step ${index} not found`);
  return s;
}

export async function filesAtStep(b: Branch, rows: Step[], index: number) {
  const dir = await repoDirFor(b);
  const commit = await commitForStep(dir, rows, index);
  const changed = new Set(stepAt(rows, index).filesChanged ?? []);
  return { commit, files: (await git.lsTree(dir, commit)).map((p) => ({ path: p, changed: changed.has(p) })) };
}

function decode(buf: Buffer): { content: string; binary: boolean } {
  const text = buf.toString("utf8");
  return text.includes("�") ? { content: buf.toString("base64"), binary: true } : { content: text, binary: false };
}

export async function fileAtStep(b: Branch, rows: Step[], index: number, filePath: string, withPrevious: boolean) {
  const dir = await repoDirFor(b);
  const commit = await commitForStep(dir, rows, index);
  let raw: Buffer;
  try { raw = await git.showFile(dir, commit, filePath); } catch { throw new RangeError("file not found at that commit"); }
  const out: Record<string, unknown> = { path: filePath, commit, ...decode(raw) };
  if (withPrevious) {
    const prevCommit = index > 0 ? await commitForStep(dir, rows, index - 1) : `${commit}^`;
    out.previous_commit = prevCommit;
    try { out.previous_content = decode(await git.showFile(dir, prevCommit, filePath)).content; } catch { out.previous_content = null; }
  }
  return out;
}

/** Messages the model saw through `index`. A tool_call row resolves to its owning assistant step. */
export function contextAtStep(b: Branch, rows: Step[], index: number) {
  const step = stepAt(rows, index);
  let effective = index;
  if (step.kind === "tool_call") effective = Math.max(...rows.filter((s) => s.kind === "assistant" && s.stepIndex < index).map((s) => s.stepIndex));
  const messages = messagesFromSteps(b.systemPrompt, rows.filter((s) => s.stepIndex <= effective));
  const following = rows.find((s) => s.stepIndex > effective && s.kind === "assistant" && s.inputTokens > 0);
  const tokenCount = following ? following.inputTokens : Math.floor(messages.reduce((n, m) => n + String(m.content ?? "").length + JSON.stringify(m.tool_calls ?? "").length, 0) / 4);
  return { step_index: effective, requested_index: index, messages, token_count: tokenCount, token_count_source: following ? "reported" : "estimated" };
}

export async function diffBetween(a: Branch, aRows: Step[], aIndex: number, b: Branch, bRows: Step[], bIndex: number) {
  const aDir = await repoDirFor(a);
  const aCommit = await commitForStep(aDir, aRows, aIndex);
  let bCommit: string;
  if (a.id === b.id) bCommit = await commitForStep(aDir, bRows, bIndex);
  else {
    const bDir = await repoDirFor(b);
    bCommit = await commitForStep(bDir, bRows, bIndex);
    if (!(await git.commitExists(aDir, bCommit))) {
      if (b.bundleKey) {
        const tmp = await storage.getToFile(b.bundleKey, path.join(os.tmpdir(), `rewind-diff-${b.id}.bundle`));
        try { await git.fetchFrom(aDir, tmp); } finally { await import("node:fs/promises").then((fs) => fs.rm(tmp, { force: true })); }
      } else await git.fetchFrom(aDir, bDir);
    }
  }
  const { patch, files } = await git.diff(aDir, aCommit, bCommit);
  return { a: { branch_id: a.id, step_index: aIndex, commit: aCommit }, b: { branch_id: b.id, step_index: bIndex, commit: bCommit }, files, patch };
}

// --- notes, search, deletion, cleanup -------------------------------------------------------

export async function setNote(branchId: string, index: number, note: string | null): Promise<Step> {
  const clean = note?.trim() ? note.trim() : null;
  const [row] = await db.update(steps).set({ note: clean }).where(and(eq(steps.branchId, branchId), eq(steps.stepIndex, index))).returning();
  if (!row) throw new RangeError("step not found");
  return row;
}

export async function searchSteps(q: string, limit = 50) {
  const pattern = `%${q}%`;
  const rows = await db.select({ step: steps, branch: branches, session: sessions, repo: repos })
    .from(steps).innerJoin(branches, eq(steps.branchId, branches.id)).innerJoin(sessions, eq(branches.sessionId, sessions.id)).innerJoin(repos, eq(sessions.repoId, repos.id))
    .where(or(ilike(steps.toolResult, pattern), ilike(sql`${steps.toolArgs}::text`, pattern), ilike(sql`${steps.content}::text`, pattern), ilike(steps.note, pattern)))
    .orderBy(desc(steps.createdAt)).limit(limit);
  const ql = q.toLowerCase();
  return rows.map(({ step, branch, session, repo }) => {
    const calls = (step.content.tool_calls as Array<{ function: { name: string; arguments?: string } }> | undefined) ?? [];
    const candidates = [step.toolResult, step.note, String(step.content.content ?? ""), ...Object.values(step.toolArgs ?? {}).filter((v): v is string => typeof v === "string"), calls.map((c) => `${c.function.name}(${c.function.arguments ?? ""})`).join("\n")];
    const hay = candidates.find((c) => c && c.toLowerCase().includes(ql)) ?? candidates.find((c) => c) ?? "";
    const i = hay.toLowerCase().indexOf(ql);
    const snippet = i >= 0 ? hay.slice(Math.max(0, i - 80), i + q.length + 120) : hay.slice(0, 200);
    return {
      session_id: session.id, session_title: session.title, repo_slug: repo.slug, branch_id: branch.id, model_id: branch.modelId,
      branch_status: branch.status, step_index: step.stepIndex, kind: step.kind, tool_name: step.toolName, snippet: snippet.trim(),
    };
  });
}

/** Remove a session, its branches and steps; bundles go to the cleanup queue and are removed with retries. */
export async function deleteSession(sessionId: string): Promise<number> {
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!sess) throw new RangeError("session not found");
  const rows = await db.select().from(branches).where(eq(branches.sessionId, sessionId));
  for (const b of rows) if (b.status === "running" || b.status === "queued") requestCancel(b.id);
  const ids = rows.map((b) => b.id);
  const keys = rows.map((b) => b.bundleKey).filter((k): k is string => !!k);
  await db.transaction(async (tx) => {
    await tx.update(sessions).set({ rootBranchId: null, deletedAt: new Date() }).where(eq(sessions.id, sessionId));
    if (ids.length) {
      await tx.delete(steps).where(inArray(steps.branchId, ids));
      await tx.update(branches).set({ parentBranchId: null }).where(inArray(branches.id, ids));
      await tx.delete(branches).where(inArray(branches.id, ids));
    }
    await tx.delete(sessions).where(eq(sessions.id, sessionId));
    if (keys.length) await tx.insert(bundleCleanupQueue).values(keys.map((bundleKey) => ({ bundleKey }))).onConflictDoNothing();
  });
  for (const id of ids) await worktree.forgetBranch(id);
  await drainBundleCleanupQueue();
  return ids.length;
}

export async function drainBundleCleanupQueue(): Promise<number> {
  const retryBefore = new Date(Date.now() - 5 * 60 * 1000);
  const queued = await db.select().from(bundleCleanupQueue)
    .where(or(isNull(bundleCleanupQueue.lastAttemptAt), sql`${bundleCleanupQueue.lastAttemptAt} <= ${retryBefore}`)).limit(50);
  let n = 0;
  for (const item of queued) {
    try {
      await storage.remove(item.bundleKey);
      await db.delete(bundleCleanupQueue).where(eq(bundleCleanupQueue.bundleKey, item.bundleKey));
      n += 1;
    } catch (e) {
      await db.update(bundleCleanupQueue).set({ attempts: item.attempts + 1, lastAttemptAt: new Date(), lastError: (e as Error).message }).where(eq(bundleCleanupQueue.bundleKey, item.bundleKey));
      logger.error({ err: e, bundleKey: item.bundleKey }, "bundle cleanup failed");
    }
  }
  return n;
}

export async function sessionTokens(sessionId: string): Promise<number> {
  const [row] = await db.select({ t: sql<string>`coalesce(sum(${branches.totalInputTokens} + ${branches.totalOutputTokens}), 0)` }).from(branches).where(eq(branches.sessionId, sessionId));
  return Number(row?.t ?? 0);
}

export async function stats() {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(branches);
  const py = sandboxPythonStatus();
  return {
    tokens_used_today: await tokensUsedToday(), daily_token_cap: settings.dailyTokenCap, branches: row?.n ?? 0,
    max_concurrent_branches: settings.maxConcurrentBranches, session_token_budget: settings.maxTotalTokensPerSession,
    sandbox_python: py, storage_backend: process.env.PRIVATE_OBJECT_DIR ? "object" : "local",
    read_only: settings.readOnly,
    public_writes: settings.publicWrites, public_daily_token_cap: settings.publicDailyTokenCap, public_max_model_calls: settings.publicMaxModelCalls,
    cheap_model: (await import("./config")).cheapestModel().id,
    // what a visitor can do right now, and why not
    writes: settings.readOnly ? "read_only" : !py.ready ? "warming_up" : "open",
  };
}
