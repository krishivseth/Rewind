/** All /api routes. Response shapes use snake_case, matching the frontend types. */
import { Router, type IRouter, type Request, type Response } from "express";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { branches, db, repos, sessions, steps, type Branch } from "@workspace/db";
import { MODELS, MODEL_IDS, settings } from "../lib/config";
import { createForks } from "../lib/fork";
import { branchView, isCancelRequested, requestCancel, stepView } from "../lib/loop";
import { publish, subscribe } from "../lib/pubsub";
import * as scheduler from "../lib/scheduler";
import * as services from "../lib/services";
import { requireKey, requireKeyOrPublic, takeBranchQuota, validKey } from "../middlewares/access-key";
import { logger } from "../lib/logger";
import { sandboxPythonStatus } from "../lib/sandbox-python";
import { finishLogin, githubConfigured, logout, startLogin, type SessionUser } from "../lib/auth";

const router: IRouter = Router();
const TERMINAL = new Set(["done", "failed", "cancelled"]);
const uuid = z.string().uuid();

class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response) => {
  fn(req, res).catch((e: unknown) => {
    if (e instanceof HttpError) res.status(e.status).json({ detail: e.message });
    else if (e instanceof z.ZodError) res.status(422).json({ detail: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    else if (e instanceof RangeError) res.status(404).json({ detail: e.message });
    else { logger.error({ err: e, path: req.path }, "request failed"); res.status(500).json({ detail: "Internal error. The server log has the details." }); }
  });
};

const bview = (b: Branch) => branchView(b, b.status === "queued" ? scheduler.queuePosition(b.id) : null);
const parseId = (s: string) => { const r = uuid.safeParse(s); if (!r.success) throw new HttpError(404, "not found"); return r.data; };

async function loadBranch(id: string): Promise<Branch> {
  const b = await services.getBranch(parseId(id));
  if (!b) throw new HttpError(404, "branch not found");
  return b;
}
async function branchAndSteps(id: string, index: number) {
  const b = await loadBranch(id);
  const rows = await services.branchSteps(b.id);
  if (!Number.isInteger(index) || index < 0 || index >= rows.length) throw new HttpError(404, `step ${index} not found (branch has ${rows.length} steps)`);
  return { b, rows };
}
async function sessionView(sessionId: string) {
  const [s] = await db.select({ session: sessions, repo: repos }).from(sessions).innerJoin(repos, eq(sessions.repoId, repos.id)).where(eq(sessions.id, sessionId));
  if (!s) throw new HttpError(404, "session not found");
  const rows = await db.select().from(branches).where(eq(branches.sessionId, sessionId)).orderBy(asc(branches.createdAt));
  return { id: s.session.id, title: s.session.title, repo_slug: s.repo.slug, repo_id: s.repo.id, root_branch_id: s.session.rootBranchId, created_at: s.session.createdAt.toISOString(), branches: rows.map(bview) };
}

// --- read ------------------------------------------------------------------------------------

router.get("/repos", wrap(async (_req, res) => {
  const rows = await db.select().from(repos).orderBy(asc(repos.slug));
  res.json(rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, description: r.description, created_at: r.createdAt.toISOString() })));
}));

router.get("/models", (_req, res) => { res.json(MODELS.map((m) => ({ id: m.id, name: m.name, cheap: m.cheap }))); });

router.get("/sessions", wrap(async (_req, res) => {
  const rows = await db.select({ session: sessions, repo: repos }).from(sessions).innerJoin(repos, eq(sessions.repoId, repos.id)).orderBy(desc(sessions.createdAt));
  const all = rows.length ? await db.select().from(branches).where(inArray(branches.sessionId, rows.map((r) => r.session.id))).orderBy(asc(branches.createdAt)) : [];
  res.json(rows.map(({ session, repo }) => {
    const mine = all.filter((b) => b.sessionId === session.id);
    const root = mine.find((b) => b.id === session.rootBranchId);
    return {
      id: session.id, title: session.title, repo_slug: repo.slug, repo_id: repo.id, root_branch_id: session.rootBranchId,
      model_id: root?.modelId ?? null, branch_count: mine.length, created_at: session.createdAt.toISOString(),
      branches: mine.map((b) => ({ id: b.id, parent_branch_id: b.parentBranchId, fork_step_index: b.forkStepIndex, status: b.status, step_count: b.stepCount })),
    };
  }));
}));

router.get("/sessions/:id", wrap(async (req, res) => { res.json(await sessionView(parseId(req.params.id as string))); }));
router.get("/branches/:id", wrap(async (req, res) => { res.json(bview(await loadBranch(req.params.id as string))); }));
router.get("/branches/:id/steps", wrap(async (req, res) => { const b = await loadBranch(req.params.id as string); res.json((await services.branchSteps(b.id)).map(stepView)); }));

router.get("/branches/:id/steps/:index/files", wrap(async (req, res) => {
  const { b, rows } = await branchAndSteps(req.params.id as string, Number(req.params.index));
  res.json(await services.filesAtStep(b, rows, Number(req.params.index)));
}));

router.get("/branches/:id/steps/:index/file", wrap(async (req, res) => {
  const p = String(req.query.path ?? "");
  if (!p || p.startsWith("/") || p.split("/").includes("..")) throw new HttpError(400, "bad path");
  const { b, rows } = await branchAndSteps(req.params.id as string, Number(req.params.index));
  res.json(await services.fileAtStep(b, rows, Number(req.params.index), p, req.query.with_previous === "true"));
}));

router.get("/branches/:id/steps/:index/context", wrap(async (req, res) => {
  const { b, rows } = await branchAndSteps(req.params.id as string, Number(req.params.index));
  res.json(services.contextAtStep(b, rows, Number(req.params.index)));
}));

function parseRef(ref: string): { id: string; index: number | null } {
  const [id, idx] = ref.split(":");
  const r = uuid.safeParse(id);
  if (!r.success || (idx !== undefined && idx !== "" && !/^\d+$/.test(idx))) throw new HttpError(400, `bad ref '${ref}'; expected branch_id:step`);
  return { id: r.data, index: idx ? Number(idx) : null };
}

router.get("/diff", wrap(async (req, res) => {
  const a = parseRef(String(req.query.a ?? "")), b = parseRef(String(req.query.b ?? ""));
  const [ba, bb] = [await services.getBranch(a.id), await services.getBranch(b.id)];
  if (!ba || !bb) throw new HttpError(404, "branch not found");
  const [aRows, bRows] = [await services.branchSteps(a.id), await services.branchSteps(b.id)];
  if (!aRows.length || !bRows.length) throw new HttpError(409, "branch has no steps yet");
  const ai = a.index ?? aRows.length - 1, bi = b.index ?? bRows.length - 1;
  if (ai >= aRows.length || bi >= bRows.length) throw new HttpError(404, "step out of range");
  res.json(await services.diffBetween(ba, aRows, ai, bb, bRows, bi));
}));

router.get("/search", wrap(async (req, res) => {
  const q = z.string().min(2).max(200).parse(req.query.q);
  const limit = z.coerce.number().int().min(1).max(200).default(50).parse(req.query.limit);
  res.json({ q, results: await services.searchSteps(q, limit) });
}));

router.get("/stats", wrap(async (_req, res) => {
  const user = res.locals.user as SessionUser | null | undefined;
  res.json({ ...(await services.stats()), sign_in: githubConfigured() ? "github" : "off", me: user ? { login: user.login, avatar: user.avatar } : null });
}));

router.get("/auth/github", startLogin);
router.get("/auth/github/callback", wrap(finishLogin));
router.post("/auth/logout", logout);
router.get("/auth/me", (_req, res) => { const u = res.locals.user as SessionUser | null | undefined; res.json(u ? { login: u.login, avatar: u.avatar } : null); });

router.get("/auth/check", (req, res) => {
  if (validKey(req.header("x-rewind-key"))) { res.json({ ok: true }); return; }
  if (!settings.accessKey) { res.status(401).json({ detail: "The server has no REWIND_ACCESS_KEY configured. Add the secret and redeploy." }); return; }
  res.status(401).json({ detail: req.header("x-rewind-key") ? "That key does not match REWIND_ACCESS_KEY." : "missing X-Rewind-Key" });
});

// --- write -----------------------------------------------------------------------------------

const modelId = z.string().refine((v) => MODEL_IDS.has(v), "unknown model");
const CreateSession = z.object({ repo_id: z.string(), title: z.string().min(1).max(256), task_prompt: z.string().min(1).max(20_000), model_id: modelId });
const ForkBody = z.object({ step_index: z.number().int().min(0), model_id: modelId, edited_task_prompt: z.string().max(20_000).nullish(), count: z.number().int().min(1).max(5).default(1) });
const NoteBody = z.object({ note: z.string().max(2000).nullish() });

async function checkDailyCap(isPublic: boolean) {
  if (settings.readOnly) throw new HttpError(503, "This deployment is read-only; sessions and forks cannot be created.");
  if (!sandboxPythonStatus().ready) throw new HttpError(503, "The sandbox is still warming up after a restart. Ready in about a minute.");
  const used = await services.tokensUsedToday();
  if (used >= settings.dailyTokenCap) throw new HttpError(429, `daily token cap reached (${used} of ${settings.dailyTokenCap}); try again tomorrow`);
  if (isPublic && used >= settings.publicDailyTokenCap) throw new HttpError(429, "Today's public budget is used up. Enter the access key to keep going, or come back tomorrow.");
}
const quota = (req: Request, res: Response, n: number) => {
  if (!takeBranchQuota(req, res.locals.keyId as string, n)) throw new HttpError(429, `rate limit: at most ${settings.rateLimitBranchesPerHour} branches per hour per key and per IP`);
};

router.post("/sessions", requireKeyOrPublic, wrap(async (req, res) => {
  const body = CreateSession.parse(req.body);
  await checkDailyCap(res.locals.public === true);
  quota(req, res, 1);
  let created;
  try { created = await services.createSession(parseId(body.repo_id), body.title, body.task_prompt, body.model_id, res.locals.keyId as string); }
  catch (e) { if ((e as Error).message === "repo not found") throw new HttpError(404, "repo not found"); throw e; }
  res.status(201).json({ id: created.session.id, root_branch_id: created.branch.id, branch: bview(created.branch) });
}));

router.post("/branches/:id/fork", requireKeyOrPublic, wrap(async (req, res) => {
  const parent = await loadBranch(req.params.id as string);
  const body = ForkBody.parse(req.body);
  await checkDailyCap(res.locals.public === true);
  const spent = await services.sessionTokens(parent.sessionId);
  if (spent >= settings.maxTotalTokensPerSession) throw new HttpError(429, `this session has used ${spent} tokens, over its budget of ${settings.maxTotalTokensPerSession}; start a new session`);
  quota(req, res, body.count);
  let ids: string[];
  try { ids = await createForks(parent.id, body.step_index, body.model_id, body.edited_task_prompt ?? null, body.count, res.locals.keyId as string); }
  catch (e) { if (e instanceof RangeError) throw new HttpError(400, e.message); throw e; }
  for (const id of ids) void scheduler.enqueue(id);
  const rows = (await db.select().from(branches).where(inArray(branches.id, ids))).sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  const effective = rows[0]?.forkStepIndex ?? body.step_index;
  res.status(201).json({ requested_step_index: body.step_index, fork_step_index: effective, snapped: effective !== body.step_index, branches: rows.map(bview) });
}));

router.post("/branches/:id/cancel", requireKey, wrap(async (req, res) => {
  const b = await loadBranch(req.params.id as string);
  if (TERMINAL.has(b.status)) { res.json(bview(b)); return; }
  requestCancel(b.id);
  if (b.status === "queued" && !scheduler.isTracked(b.id)) {
    const [row] = await db.update(branches).set({ status: "cancelled", error: "cancelled while queued", finishedAt: new Date() }).where(eq(branches.id, b.id)).returning();
    publish(b.id, { type: "status", data: branchView(row!) });
  }
  res.json({ ok: true, id: b.id, cancel_requested: isCancelRequested(b.id) });
}));

router.put("/branches/:id/steps/:index/note", requireKey, wrap(async (req, res) => {
  const b = await loadBranch(req.params.id as string);
  const body = NoteBody.parse(req.body);
  const step = await services.setNote(b.id, Number(req.params.index), body.note ?? null);
  const view = stepView(step);
  publish(b.id, { type: "step", data: view });
  res.json(view);
}));

router.delete("/sessions/:id", requireKey, wrap(async (req, res) => {
  const n = await services.deleteSession(parseId(req.params.id as string));
  res.json({ ok: true, branches_deleted: n });
}));

// --- SSE -------------------------------------------------------------------------------------

router.get("/branches/:id/events", wrap(async (req, res) => {
  const b = await loadBranch(req.params.id as string);
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  let last = -1;
  let closed = false;
  const buffered: Array<{ type: string; data: Record<string, unknown> }> = [];
  // subscribe before replaying so nothing published during the replay is lost
  const unsubscribe = subscribe(b.id, (ev) => {
    if (closed) return;
    if (replaying) { buffered.push(ev); return; }
    deliver(ev);
  });
  const deliver = (ev: { type: string; data: Record<string, unknown> }) => {
    if (ev.type === "step") {
      const idx = ev.data.index as number;
      if (idx <= last) return;
      last = idx;
    }
    send(ev.type, ev);
    if (ev.type === "status" && TERMINAL.has(String(ev.data.status))) finish();
  };
  const keepAlive = setInterval(() => { if (!closed) res.write(": keepalive\n\n"); }, 15_000);
  const finish = () => { if (closed) return; closed = true; clearInterval(keepAlive); unsubscribe(); res.end(); };
  req.on("close", finish);
  let replaying = true;
  const rows = await services.branchSteps(b.id);
  for (const s of rows) { last = s.stepIndex; send("step", { type: "step", data: stepView(s) }); }
  const current = await services.getBranch(b.id);
  send("status", { type: "status", data: bview(current!) });
  replaying = false;
  if (TERMINAL.has(current!.status)) { finish(); return; }
  buffered.splice(0).forEach(deliver);
}));

export default router;
