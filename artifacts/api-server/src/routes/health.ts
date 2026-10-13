import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

const router: IRouter = Router();
// liveness: the process is up
router.get("/health", (_req, res) => { res.json({ ok: true }); });
// readiness: the database answers; used by deployment health checks
const ready = async (_req: unknown, res: import("express").Response) => {
  try { await db.execute(sql`select 1`); res.json({ status: "ok", db: "ok" }); }
  catch (e) { res.status(503).json({ status: "degraded", db: (e as Error).message.slice(0, 200) }); }
};
router.get("/ready", ready);
router.get("/healthz", ready);
export default router;
