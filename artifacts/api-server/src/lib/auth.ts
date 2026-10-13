/**
 * Sign in with GitHub. The OAuth token is used once to read the profile and never stored; the
 * session is a signed cookie carrying { id, login, avatar }. Writes accept either the access key
 * (full powers) or a signed-in user (cheap model, per-user quota, shared public budget).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { settings } from "./config";

export interface SessionUser { id: string; login: string; avatar: string | null }

const COOKIE = "rewind_session";
const STATE_COOKIE = "rewind_oauth_state";
const MAX_AGE_S = 30 * 24 * 3600;

export const githubConfigured = () => !!(settings.githubClientId && settings.githubClientSecret && settings.sessionSecret);

function sign(payload: string): string {
  return createHmac("sha256", settings.sessionSecret).update(payload).digest("base64url");
}

export function encodeSession(user: SessionUser): string {
  const body = Buffer.from(JSON.stringify({ ...user, exp: Math.floor(Date.now() / 1000) + MAX_AGE_S })).toString("base64url");
  return `${body}.${sign(body)}`;
}

export function decodeSession(token: string | undefined): SessionUser | null {
  if (!token || !settings.sessionSecret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString()) as SessionUser & { exp: number };
    if (data.exp < Date.now() / 1000) return null;
    return { id: String(data.id), login: data.login, avatar: data.avatar ?? null };
  } catch { return null; }
}

const secure = (req: Request) => req.secure || req.header("x-forwarded-proto") === "https";

/** Attach req user from the cookie, if any. */
export function sessionMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.locals.user = decodeSession((req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE]);
  next();
}

export function publicBaseUrl(req: Request): string {
  if (settings.publicUrl) return settings.publicUrl.replace(/\/$/, "");
  const proto = secure(req) ? "https" : "http";
  return `${proto}://${req.get("host")}`;
}

export function startLogin(req: Request, res: Response): void {
  if (!githubConfigured()) { res.status(503).json({ detail: "Sign-in is not configured on this server." }); return; }
  const state = randomBytes(16).toString("hex");
  const returnTo = typeof req.query.return_to === "string" && req.query.return_to.startsWith("/") ? req.query.return_to : "/";
  res.cookie(STATE_COOKIE, `${state}|${returnTo}`, { httpOnly: true, sameSite: "lax", secure: secure(req), maxAge: 10 * 60_000, path: "/" });
  const params = new URLSearchParams({
    client_id: settings.githubClientId, redirect_uri: `${publicBaseUrl(req)}/api/auth/github/callback`, scope: "read:user", state,
  });
  res.redirect(`https://github.com/login/oauth/authorize?${params}`);
}

export async function finishLogin(req: Request, res: Response): Promise<void> {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies ?? {};
  const [savedState, returnTo = "/"] = (cookies[STATE_COOKIE] ?? "").split("|");
  res.clearCookie(STATE_COOKIE, { path: "/" });
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state || !savedState || state !== savedState) { res.status(400).send("Sign-in state mismatch. Go back and try again."); return; }
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: settings.githubClientId, client_secret: settings.githubClientSecret, code, redirect_uri: `${publicBaseUrl(req)}/api/auth/github/callback` }),
  });
  const token = (await tokenRes.json()) as { access_token?: string; error?: string };
  if (!token.access_token) { res.status(400).send(`GitHub did not issue a token${token.error ? `: ${token.error}` : ""}.`); return; }
  const profileRes = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "rewind" } });
  const profile = (await profileRes.json()) as { id: number; login: string; avatar_url?: string };
  if (!profile.id) { res.status(400).send("Could not read your GitHub profile."); return; }
  const user: SessionUser = { id: String(profile.id), login: profile.login, avatar: profile.avatar_url ?? null };
  res.cookie(COOKIE, encodeSession(user), { httpOnly: true, sameSite: "lax", secure: secure(req), maxAge: MAX_AGE_S * 1000, path: "/" });
  res.redirect(returnTo);
}

export function logout(_req: Request, res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
  res.json({ ok: true });
}
