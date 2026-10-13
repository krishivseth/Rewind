import { existsSync } from "node:fs";
import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Walk up from this module (source or bundle) to the workspace root. */
function findRepoRoot(): string {
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const repoRoot = findRepoRoot();
// relative paths are relative to the repository root, whatever the working directory is
function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
}

/** All runtime settings. Read once at import; tests mutate `settings` directly. */
export const settings = {
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  accessKey: process.env.REWIND_ACCESS_KEY ?? "",
  // Replit's repo filesystem is not a safe place for runtime data in a deployment; bundles go to App
  // Storage there (PRIVATE_OBJECT_DIR) and scratch data to /tmp.
  dataDir: resolveFromRoot(process.env.DATA_DIR ?? (process.env.REPL_ID ? "/tmp/rewind/data" : "./data")),
  branchesRoot: process.env.BRANCHES_ROOT ?? "/tmp/rewind/branches",
  restoreRoot: process.env.RESTORE_ROOT ?? "/tmp/rewind/restores",
  seedReposDir: process.env.SEED_REPOS_DIR ?? path.join(repoRoot, "seed_repos"),
  frontendDist: process.env.FRONTEND_DIST ?? path.join(repoRoot, "artifacts/rewind/dist/public"),

  maxModelCalls: num("MAX_MODEL_CALLS", 30),
  maxOutputTokensPerCall: num("MAX_OUTPUT_TOKENS_PER_CALL", 4000),
  maxTotalTokensPerBranch: num("MAX_TOTAL_TOKENS_PER_BRANCH", 150_000),
  wallClockSecondsPerBranch: num("WALL_CLOCK_SECONDS_PER_BRANCH", 600),
  dailyTokenCap: num("REWIND_DAILY_TOKEN_CAP", 2_000_000),
  maxConcurrentBranches: num("MAX_CONCURRENT_BRANCHES", 4),
  loopWarnAfter: num("LOOP_WARN_AFTER", 3),
  loopFailAfter: num("LOOP_FAIL_AFTER", 4),
  openrouterMaxRetries: num("OPENROUTER_MAX_RETRIES", 4),
  runTimeoutSeconds: num("RUN_TIMEOUT_SECONDS", 60),
  toolOutputLimit: num("TOOL_OUTPUT_LIMIT", 20_000),
  restoreCacheSeconds: num("RESTORE_CACHE_SECONDS", 600),
  rateLimitBranchesPerHour: num("RATE_LIMIT_BRANCHES_PER_HOUR", 10),
  sandboxMaxFileMb: num("SANDBOX_MAX_FILE_MB", 64),
  sandboxMaxProcs: num("SANDBOX_MAX_PROCS", 256),
  sandboxMaxMemoryMb: num("SANDBOX_MAX_MEMORY_MB", 2048),
  sandboxUnshareNet: (process.env.SANDBOX_UNSHARE_NET ?? "1") !== "0",
  leaseSeconds: num("RUN_LEASE_SECONDS", 900),
  maxTotalTokensPerSession: num("MAX_TOTAL_TOKENS_PER_SESSION", 300_000),
  readOnly: (process.env.REWIND_READ_ONLY ?? "0") === "1",
  // "cheap": visitors without the key may create sessions and forks on the cheap model, within the
  // per-IP rate limit and PUBLIC_DAILY_TOKEN_CAP. "off": every write needs the key (the spec's default).
  publicWrites: (process.env.REWIND_PUBLIC_WRITES ?? "cheap") as "cheap" | "signed_in" | "off",
  publicDailyTokenCap: num("PUBLIC_DAILY_TOKEN_CAP", 500_000),
  // shorter runs for visitors: forks of a half-finished run rarely need more
  publicMaxModelCalls: num("PUBLIC_MAX_MODEL_CALLS", 20),
  // "signed_in": keyless writes need a GitHub sign-in; "cheap": anyone; "off": key only
  githubClientId: process.env.GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
  sessionSecret: process.env.SESSION_SECRET ?? "",
  publicUrl: process.env.PUBLIC_URL ?? "",
};

export interface Model {
  id: string;
  name: string;
  cheap: boolean;
  usdPerMInput: number;
  usdPerMOutput: number;
}

// OpenRouter ids verified against /api/v1/models on 2026-09-09; all advertise tool calling.
export const MODELS: Model[] = [
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", cheap: false, usdPerMInput: 2, usdPerMOutput: 10 },
  { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini", cheap: false, usdPerMInput: 0.75, usdPerMOutput: 4.5 },
  { id: "google/gemini-3.8-flash", name: "Gemini 3.8 Flash", cheap: false, usdPerMInput: 0.75, usdPerMOutput: 3.75 },
  { id: "moonshotai/kimi-k3", name: "Kimi K3", cheap: false, usdPerMInput: 3, usdPerMOutput: 15 },
  { id: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash", cheap: true, usdPerMInput: 0.09, usdPerMOutput: 0.18 },
];
export const MODEL_IDS = new Set(MODELS.map((m) => m.id));
export const cheapestModel = (): Model => MODELS.find((m) => m.cheap) ?? MODELS[0]!;

export function estimateCostUsd(modelId: string, input: number, output: number): number {
  const m = MODELS.find((x) => x.id === modelId);
  if (!m) return 0;
  return (input / 1e6) * m.usdPerMInput + (output / 1e6) * m.usdPerMOutput;
}

export const SYSTEM_PROMPT = `You are a coding agent working inside a git repository.
You have four tools: read_file(path), write_file(path, content), edit_file(path, old_string, new_string), and run(command).
run only accepts the named commands listed in the repository's .rewind.json (for example "test"); any other command is rejected.
Start with read_file(".") to list the repository, then read the relevant files, make focused edits, and run the "test" command before you finish.
Do not repeat a call whose result you already have.
If the repository has no tests for what you built, write a small pytest file for it; a test run that reports "no tests ran" is not a failure.
When the task is complete, reply with a short summary and no tool calls.`;
