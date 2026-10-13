/** Access key check and in-memory write rate limiting. Viewing is public; writes need X-Rewind-Key. */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { SessionUser } from "../lib/auth";
import { cheapestModel, settings } from "../lib/config";

export const keyId = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

export function validKey(key: string | undefined): boolean {
  if (!key || !settings.accessKey) return false;
  const a = Buffer.from(key), b = Buffer.from(settings.accessKey);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Like requireKey, but lets a visitor through on the cheap model when public writes are on.
 * Sets res.locals.public = true and a per-IP key id so the rate limit still applies.
 */
export function requireKeyOrPublic(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("x-rewind-key");
  if (validKey(key)) { res.locals.keyId = keyId(key!); res.locals.public = false; next(); return; }
  const user = res.locals.user as SessionUser | null | undefined;
  if (settings.publicWrites === "off" || (settings.publicWrites === "signed_in" && !user)) {
    if (settings.publicWrites === "signed_in" && !key) { res.status(401).json({ detail: "Sign in with GitHub to fork, or enter the access key.", sign_in: true }); return; }
    requireKey(req, res, next); return;
  }
  const model = (req.body as { model_id?: unknown } | undefined)?.model_id;
  if (model !== cheapestModel().id) {
    res.status(401).json({ detail: `${user ? "Signed-in visitors" : "Visitors"} can run ${cheapestModel().name}. Enter the access key to use other models.` });
    return;
  }
  // quota bucket: the GitHub account when signed in, otherwise the IP
  res.locals.keyId = user ? `user:${user.id}` : `public:${clientIp(req)}`;
  res.locals.public = true;
  next();
}

export function requireKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.header("x-rewind-key");
  if (!validKey(key)) { res.status(401).json({ detail: "missing or invalid X-Rewind-Key" }); return; }
  res.locals.keyId = keyId(key!);
  next();
}

class SlidingWindow {
  private events = new Map<string, number[]>();
  constructor(private windowMs = 3_600_000) {}
  private prune(bucket: string): number[] {
    const now = Date.now();
    const q = (this.events.get(bucket) ?? []).filter((t) => t > now - this.windowMs);
    this.events.set(bucket, q);
    return q;
  }
  remaining(bucket: string, limit: number): number { return Math.max(0, limit - this.prune(bucket).length); }
  take(bucket: string, n: number): void { const q = this.prune(bucket); const now = Date.now(); for (let i = 0; i < n; i += 1) q.push(now); }
  reset(): void { this.events.clear(); }
}
export const branchLimiter = new SlidingWindow();

/** req.ip already honours `trust proxy`, so a client cannot invent its own address. */
export const clientIp = (req: Request) => req.ip || "unknown";

/** Reserve n branch creations against both the key and the IP, or return false. */
export function takeBranchQuota(req: Request, key: string, n: number): boolean {
  const limit = settings.rateLimitBranchesPerHour;
  const ip = clientIp(req);
  if (branchLimiter.remaining(`key:${key}`, limit) < n || branchLimiter.remaining(`ip:${ip}`, limit) < n) return false;
  branchLimiter.take(`key:${key}`, n);
  branchLimiter.take(`ip:${ip}`, n);
  return true;
}
