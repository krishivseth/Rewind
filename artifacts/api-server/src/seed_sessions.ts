import "./env";
/**
 * Create the three seed sessions through the HTTP API. Spends real tokens (about a cent).
 *
 *   REWIND_ACCESS_KEY=... node artifacts/api-server/dist/seed_sessions.mjs [--base http://localhost:8080]
 *
 * Ten branches total, exactly the per-hour write limit, so wait an hour before re-running.
 */
import { MODELS, cheapestModel } from "./lib/config";

const TERMINAL = new Set(["done", "failed", "cancelled"]);
const FORK_STEP = 6;
const base = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1]! : (process.env.REWIND_BASE_URL ?? "http://localhost:8080");
const key = process.env.REWIND_ACCESS_KEY;
if (!key) { console.error("REWIND_ACCESS_KEY is not set"); process.exit(2); }

const log = (msg: string) => console.log(`[${new Date().toTimeString().slice(0, 8)}] ${msg}`);
type Branch = { id: string; status: string; step_count: number; total_input_tokens: number; total_output_tokens: number; error?: string | null };

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(base + url, { method, headers: { "X-Rewind-Key": key!, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitDone(id: string): Promise<Branch> {
  for (;;) {
    const b = await api<Branch>("GET", `/api/branches/${id}`);
    if (TERMINAL.has(b.status)) { if (b.status !== "done") log(`  branch ${id.slice(0, 8)} ended ${b.status}: ${b.error ?? ""}`); return b; }
    await sleep(2000);
  }
}

async function main() {
  const repos = await api<Array<{ id: string; slug: string }>>("GET", "/api/repos");
  const repo = (slug: string) => { const r = repos.find((x) => x.slug === slug); if (!r) throw new Error(`repo ${slug} missing`); return r.id; };
  const cheap = cheapestModel().id;
  const others = MODELS.filter((m) => m.id !== cheap).slice(0, 2).map((m) => m.id);
  const created: string[] = [];

  const s1 = await api<{ id: string; root_branch_id: string }>("POST", "/api/sessions", { repo_id: repo("csv-stats"), title: "Five identical forks of one bug fix", task_prompt: "Make all tests pass", model_id: cheap });
  log(`csv-stats session ${s1.id} root ${s1.root_branch_id.slice(0, 8)}`);
  const root1 = await waitDone(s1.root_branch_id);
  log(`  root ${root1.status} after ${root1.step_count} steps`);
  const f1 = await api<{ fork_step_index: number; snapped: boolean; branches: Branch[] }>("POST", `/api/branches/${s1.root_branch_id}/fork`, { step_index: Math.min(FORK_STEP, root1.step_count - 1), model_id: cheap, count: 5 });
  log(`  forked 5x from step ${f1.fork_step_index}${f1.snapped ? " (snapped)" : ""}`);
  created.push(s1.root_branch_id, ...f1.branches.map((b) => b.id));

  const s2 = await api<{ id: string; root_branch_id: string }>("POST", "/api/sessions", { repo_id: repo("rate-limiter"), title: "Same task, three models", task_prompt: "Find and fix the bug so tests pass", model_id: cheap });
  log(`rate-limiter session ${s2.id} root ${s2.root_branch_id.slice(0, 8)}`);
  const root2 = await waitDone(s2.root_branch_id);
  log(`  root ${root2.status} after ${root2.step_count} steps`);
  created.push(s2.root_branch_id);
  for (const m of others) {
    const f = await api<{ fork_step_index: number; branches: Branch[] }>("POST", `/api/branches/${s2.root_branch_id}/fork`, { step_index: Math.min(FORK_STEP, root2.step_count - 1), model_id: m, count: 1 });
    log(`  forked ${m} from step ${f.fork_step_index}`);
    created.push(...f.branches.map((b) => b.id));
  }

  const s3 = await api<{ id: string; root_branch_id: string }>("POST", "/api/sessions", { repo_id: repo("tiny-todo"), title: "Add a feature to a small Flask app", task_prompt: "Add a DELETE /todos/{id} route with a test", model_id: cheap });
  log(`tiny-todo session ${s3.id} root ${s3.root_branch_id.slice(0, 8)}`);
  created.push(s3.root_branch_id);

  let tin = 0, tout = 0;
  for (const id of created) { const b = await waitDone(id); tin += b.total_input_tokens; tout += b.total_output_tokens; }
  log(`done. ${created.length} branches, ${tin} input + ${tout} output tokens`);
  log(`open ${base}/sessions/${s1.id}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
