import "./setup";
import { sql } from "drizzle-orm";
import { db, pool, repos, type Repo } from "@workspace/db";
import { settings } from "../src/lib/config";
import { ensureSandboxPython } from "../src/lib/sandbox-python";
import { migrate } from "../src/lib/migrate";
import { FakeClassifier, setClassifier, type Decision } from "../src/lib/security/classify";
import * as worktree from "../src/lib/worktree";

export const SEED_DIR = process.env.SEED_REPOS_DIR!;

/** Install a scripted classifier so no test ever calls OpenRouter. */
export function fakeClassifier(decisions: Decision[] = []): FakeClassifier {
  const c = new FakeClassifier(decisions);
  setClassifier(c);
  return c;
}

let migrated = false;
export async function resetDb(): Promise<void> {
  if (!migrated) { await migrate(); migrated = true; }
  await db.execute(sql`truncate steps, branches, sessions, repos, bundle_cleanup_queue cascade`);
  await worktree.clearRestoreCache();
  fakeClassifier();
}

export async function seedRepo(slug = "csv-stats"): Promise<Repo> {
  const key = await worktree.createRepoBundle(slug, `${SEED_DIR}/${slug}`);
  const [repo] = await db.insert(repos).values({ slug, name: slug, description: "", bundleKey: key }).returning();
  return repo!;
}

export const python = () => ensureSandboxPython();
export const closeDb = () => pool.end();
export { settings };
