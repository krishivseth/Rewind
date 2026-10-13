/**
 * The four agent tools and the sandbox that constrains them. Everything fails closed: a path that
 * escapes the worktree, a symlink, or a command not in .rewind.json becomes an error string that is
 * recorded and fed back to the model. Nothing else is executable.
 */
import { spawn, execFile } from "node:child_process";
import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./config";
import { ensureSandboxPython, sandboxPath, sandboxPythonStatus } from "./sandbox-python";

const execFileAsync = promisify(execFile);

export class ToolError extends Error {}

export const TOOL_SCHEMAS = [
  { type: "function", function: { name: "read_file", description: 'Read a file inside the repository and return its contents. Given a directory (for example ".") it lists the files under it instead.', parameters: { type: "object", properties: { path: { type: "string", description: "Path relative to the repo root." } }, required: ["path"], additionalProperties: false } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file inside the repository with the given content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false } } },
  { type: "function", function: { name: "edit_file", description: "Replace exactly one occurrence of old_string with new_string in a file. Fails if old_string is missing or matches more than once.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"], additionalProperties: false } } },
  { type: "function", function: { name: "run", description: 'Run one of the named commands from .rewind.json (for example "test"). Returns stdout, stderr and the exit code.', parameters: { type: "object", properties: { command: { type: "string", description: 'A command name such as "test".' } }, required: ["command"], additionalProperties: false } } },
] as const;

export const MUTATING_TOOLS = new Set(["write_file", "edit_file"]);

/** Map a model-supplied path to a real path under the worktree, or throw. Rejects .., escapes, symlinks, .git. */
export async function resolvePath(worktree: string, raw: string): Promise<string> {
  if (!raw || !raw.trim()) throw new ToolError("path is empty");
  const root = path.resolve(worktree);
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) throw new ToolError(`path escapes the repository: ${raw}`);
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ToolError(`path is outside the repository: ${raw}`);
  if (rel.split(path.sep)[0] === ".git") throw new ToolError("paths under .git are not allowed");
  let cur = root;
  for (const part of rel === "" ? [] : rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st;
    try { st = await lstat(cur); } catch { break; }
    if (st.isSymbolicLink()) throw new ToolError(`symlinks are not allowed: ${raw}`);
  }
  return candidate;
}

function truncate(s: string, limit = settings.toolOutputLimit): string {
  return s.length <= limit ? s : `${s.slice(0, limit)}\n... [truncated ${s.length - limit} chars]`;
}

async function listing(worktree: string, dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "__pycache__", ".pytest_cache", "node_modules"].includes(e.name)) continue;
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(path.relative(worktree, full).split(path.sep).join("/"));
    }
  };
  await walk(dir);
  return out.length ? out.join("\n") : "(empty directory)";
}

export async function readFileTool(worktree: string, p: string): Promise<string> {
  const target = await resolvePath(worktree, p);
  let st;
  try { st = await stat(target); } catch { throw new ToolError(`no such file: ${p}. Use read_file(".") to list the repository.`); }
  if (st.isDirectory()) return truncate(await listing(path.resolve(worktree), target));
  if (!st.isFile()) throw new ToolError(`no such file: ${p}`);
  return truncate(await readFile(target, "utf8"));
}

export async function writeFileTool(worktree: string, p: string, content: string): Promise<string> {
  const target = await resolvePath(worktree, p);
  try { if ((await stat(target)).isDirectory()) throw new ToolError(`${p} is a directory`); } catch (e) { if (e instanceof ToolError) throw e; }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return `wrote ${content.length} chars to ${p}`;
}

export async function editFileTool(worktree: string, p: string, oldString: string, newString: string): Promise<string> {
  const target = await resolvePath(worktree, p);
  let text: string;
  try { text = await readFile(target, "utf8"); } catch { throw new ToolError(`no such file: ${p}`); }
  if (!oldString) throw new ToolError("old_string must not be empty");
  const n = text.split(oldString).length - 1;
  if (n === 0) throw new ToolError("old_string not found in file");
  if (n > 1) throw new ToolError(`old_string matches ${n} times; make it unique`);
  await writeFile(target, text.replace(oldString, () => newString), "utf8");
  return `edited ${p}`;
}

export async function loadWhitelist(worktree: string): Promise<Record<string, string>> {
  try {
    const data = JSON.parse(await readFile(path.join(worktree, ".rewind.json"), "utf8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch { return {}; }
}

/** Only PATH (with the sandbox python first), HOME=worktree, and PYTHONDONTWRITEBYTECODE. No secrets. */
export function sandboxEnv(worktree: string): Record<string, string> {
  return { PATH: sandboxPath(), HOME: worktree, PYTHONDONTWRITEBYTECODE: "1" };
}

let probe: { at: number; prefix: string[] } | null = null;
const PROBE_TTL_MS = 600_000;

/** `unshare -n` / `unshare -rn` when the host allows it (Linux only), re-probed every ten minutes. */
export async function networkIsolationPrefix(): Promise<string[]> {
  if (probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.prefix;
  let prefix: string[] = [];
  if (settings.sandboxUnshareNet && os.platform() === "linux") {
    for (const flags of ["-n", "-rn"]) {
      try { await execFileAsync("unshare", [flags, "true"], { timeout: 5000 }); prefix = ["unshare", flags, "--"]; break; } catch { /* try next */ }
    }
  }
  probe = { at: Date.now(), prefix };
  return prefix;
}

/** ulimit in a POSIX sh: file size (KB blocks), process count, virtual memory (KB). Best effort per limit. */
function ulimitPrefix(): string[] {
  const kb = (mb: number) => String(mb * 1024);
  const parts = [
    `ulimit -f ${kb(settings.sandboxMaxFileMb)} 2>/dev/null`,
    `ulimit -u ${settings.sandboxMaxProcs} 2>/dev/null`,
    os.platform() === "linux" ? `ulimit -v ${kb(settings.sandboxMaxMemoryMb)} 2>/dev/null` : "true",
  ];
  return ["/bin/sh", "-c", `${parts.join("; ")}; exec "$0" "$@"`];
}

function shellSplit(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export async function runTool(worktree: string, command: string): Promise<string> {
  const whitelist = await loadWhitelist(worktree);
  if (!(command in whitelist)) {
    const allowed = Object.keys(whitelist).sort().join(", ") || "(none)";
    throw new ToolError(`command '${command}' is not whitelisted. Allowed commands: ${allowed}`);
  }
  const argv = shellSplit(whitelist[command]!);
  if (!argv.length) throw new ToolError(`command '${command}' is empty`);
  if (/^python/.test(argv[0]!) && !sandboxPythonStatus().ready) await ensureSandboxPython();
  const full = [...(await networkIsolationPrefix()), ...ulimitPrefix(), ...argv];
  const limit = Math.floor(settings.toolOutputLimit / 2);
  return new Promise((resolve) => {
    const child = spawn(full[0]!, full.slice(1), { cwd: worktree, env: sandboxEnv(worktree), stdio: ["ignore", "pipe", "pipe"], detached: true });
    let out = "", err = "", timedOut = false;
    child.stdout.on("data", (d: Buffer) => { if (out.length < limit * 2) out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { if (err.length < limit * 2) err += d.toString(); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ } }, settings.runTimeoutSeconds * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exit = timedOut ? "timeout" : code === null ? `signal ${signal}` : String(code);
      let text = `$ ${whitelist[command]}\nexit code: ${exit}\n--- stdout ---\n${truncate(out, limit)}\n--- stderr ---\n${truncate(err, limit)}`;
      if (timedOut) text += `\n[killed after ${settings.runTimeoutSeconds}s]`;
      resolve(text);
    });
    child.on("error", (e) => { clearTimeout(timer); resolve(`$ ${whitelist[command]}\nexit code: spawn-error\n--- stdout ---\n\n--- stderr ---\n${e.message}`); });
  });
}

export interface ToolOutcome { output: string; ok: boolean; mutates: boolean }

/** Dispatch a tool call. Errors become tool output, never exceptions. */
export async function execute(worktree: string, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const str = (k: string) => String(args[k] ?? "");
  try {
    switch (name) {
      case "read_file": return { output: await readFileTool(worktree, str("path")), ok: true, mutates: false };
      case "write_file": return { output: await writeFileTool(worktree, str("path"), str("content")), ok: true, mutates: true };
      case "edit_file": return { output: await editFileTool(worktree, str("path"), str("old_string"), str("new_string")), ok: true, mutates: true };
      case "run": return { output: await runTool(worktree, str("command")), ok: true, mutates: true };
      default: throw new ToolError(`unknown tool: ${name}`);
    }
  } catch (e) {
    if (e instanceof ToolError) return { output: `error: ${e.message}`, ok: false, mutates: false };
    return { output: `error: ${(e as Error).name}: ${(e as Error).message}`, ok: false, mutates: false };
  }
}
