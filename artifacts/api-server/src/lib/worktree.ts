/** Scratch worktrees under BRANCHES_ROOT, bundles in storage, and a TTL cache of restored repos. */
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { settings } from "./config";
import * as git from "./gitwrap";
import * as storage from "./storage";

export const branchDir = (branchId: string) => path.join(settings.branchesRoot, branchId);
export const repoBundleKey = (slug: string) => `repos/${slug}.bundle`;
export const branchBundleKey = (branchId: string) => `bundles/${branchId}.bundle`;

async function withTmp<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Turn a seed directory into a one-commit bundle stored under repos/{slug}.bundle. */
export async function createRepoBundle(slug: string, sourceDir: string): Promise<string> {
  return withTmp("rewind-seed-", async (tmp) => {
    const work = path.join(tmp, "repo");
    await cp(sourceDir, work, { recursive: true, filter: (src) => !/(^|\/)(__pycache__|\.pytest_cache|\.git)(\/|$)/.test(src) });
    await git.init(work);
    await git.commitAll(work, "base");
    const bundle = path.join(tmp, "repo.bundle");
    await git.bundleCreate(work, bundle);
    return storage.putFile(repoBundleKey(slug), bundle);
  });
}

export async function restoreBundle(key: string, dest: string): Promise<string> {
  await mkdir(path.dirname(dest), { recursive: true });
  await withTmp("rewind-bundle-", async (tmp) => {
    const local = await storage.getToFile(key, path.join(tmp, "b.bundle"));
    await git.cloneBundle(local, dest, path.dirname(dest));
  });
  return dest;
}

/** Root branches clone the repo bundle; forks clone the parent's bundle (or live worktree) then reset to startCommit. */
export async function prepareBranchWorktree(branchId: string, baseBundleKey: string, parentBundleKey: string | null, parentBranchId: string | null, startCommit: string | null): Promise<string> {
  const dest = branchDir(branchId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  if (parentBundleKey) {
    // a finished parent must have its bundle; falling back to the base repo would silently lose history
    if (!(await storage.exists(parentBundleKey))) throw new Error(`parent bundle ${parentBundleKey} is missing from storage (DATA_DIR or object storage changed?)`);
    await restoreBundle(parentBundleKey, dest);
  } else if (parentBranchId && existsSync(branchDir(parentBranchId))) await git.cloneLocal(branchDir(parentBranchId), dest, path.dirname(dest));
  else await restoreBundle(baseBundleKey, dest);
  if (startCommit) {
    if (!(await git.commitExists(dest, startCommit))) throw new Error(`start commit ${startCommit} not found in restored history`);
    await git.resetHard(dest, startCommit);
  } else if (parentBundleKey || parentBranchId) {
    // forked before the parent's first commit: the repo must be the base state, not the parent's HEAD
    await git.resetHard(dest, await git.rootCommit(dest));
  }
  return dest;
}

/** Bundle the worktree's full history into storage and delete the worktree. */
export async function finalizeBranch(branchId: string): Promise<string | null> {
  const wt = branchDir(branchId);
  if (!existsSync(wt)) return null;
  const key = branchBundleKey(branchId);
  await withTmp("rewind-final-", async (tmp) => {
    const bundle = path.join(tmp, "b.bundle");
    await git.bundleCreate(wt, bundle);
    await storage.putFile(key, bundle);
  });
  await rm(wt, { recursive: true, force: true });
  return key;
}

// --- restore cache -------------------------------------------------------------------------

const restored = new Map<string, { dir: string; at: number }>();
const locks = new Map<string, Promise<string>>();

/** Read-only clone of a finished branch's bundle, cached; a running branch returns its live worktree (git objects only). */
export async function restoredRepo(branchId: string, bundleKey: string | null): Promise<string> {
  if (!bundleKey) {
    const live = branchDir(branchId);
    if (existsSync(live)) return live;
    throw new Error("branch has no bundle and no live worktree");
  }
  const hit = restored.get(branchId);
  if (hit && existsSync(hit.dir)) { hit.at = Date.now(); return hit.dir; }
  const pending = locks.get(branchId);
  if (pending) return pending;
  const p = (async () => {
    const dest = path.join(settings.restoreRoot, branchId);
    await rm(dest, { recursive: true, force: true });
    await restoreBundle(bundleKey, dest);
    restored.set(branchId, { dir: dest, at: Date.now() });
    return dest;
  })().finally(() => locks.delete(branchId));
  locks.set(branchId, p);
  return p;
}

export async function evictStaleRestores(): Promise<number> {
  let n = 0;
  for (const [id, { dir, at }] of [...restored]) {
    if (Date.now() - at > settings.restoreCacheSeconds * 1000) { await rm(dir, { recursive: true, force: true }); restored.delete(id); n += 1; }
  }
  return n;
}

export async function sweepRestores(): Promise<number> {
  restored.clear();
  if (!existsSync(settings.restoreRoot)) return 0;
  const entries = await readdir(settings.restoreRoot);
  await Promise.all(entries.map((e) => rm(path.join(settings.restoreRoot, e), { recursive: true, force: true })));
  return entries.length;
}

export async function forgetBranch(branchId: string): Promise<void> {
  await rm(branchDir(branchId), { recursive: true, force: true });
  const hit = restored.get(branchId);
  if (hit) { await rm(hit.dir, { recursive: true, force: true }); restored.delete(branchId); }
}

export async function clearRestoreCache(): Promise<void> {
  for (const { dir } of restored.values()) await rm(dir, { recursive: true, force: true });
  restored.clear();
}
