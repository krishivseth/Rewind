import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {}

const GIT_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: "/nonexistent", // never pick up the operator's global identity, hooks or signing
};

export async function git(cwd: string, args: string[], opts?: { check?: boolean; timeoutMs?: number; binary?: false }): Promise<string>;
export async function git(cwd: string, args: string[], opts: { check?: boolean; timeoutMs?: number; binary: true }): Promise<Buffer>;
export async function git(cwd: string, args: string[], opts: { check?: boolean; timeoutMs?: number; binary?: boolean } = {}): Promise<string | Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd, env: GIT_ENV, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024,
      encoding: opts.binary ? "buffer" : "utf8",
    });
    return stdout as string | Buffer;
  } catch (error) {
    if (opts.check === false) return opts.binary ? Buffer.alloc(0) : "";
    const e = error as { stderr?: string | Buffer; code?: number | string };
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new GitError(`git ${args.join(" ")} failed (${e.code ?? "?"}): ${stderr.trim()}`);
  }
}

export async function setIdentity(cwd: string): Promise<void> {
  await git(cwd, ["config", "user.name", "Rewind"]);
  await git(cwd, ["config", "user.email", "rewind@localhost"]);
  await git(cwd, ["config", "commit.gpgsign", "false"]);
}

export async function init(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main"]);
  await setIdentity(cwd);
}

export const head = async (cwd: string) => (await git(cwd, ["rev-parse", "HEAD"])).trim();
export const isDirty = async (cwd: string) => (await git(cwd, ["status", "--porcelain"])).trim().length > 0;

export async function commitAll(cwd: string, message: string, allowEmpty = true): Promise<string> {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["commit", "-q", "-m", message, ...(allowEmpty ? ["--allow-empty"] : [])]);
  return head(cwd);
}

export async function filesChangedIn(cwd: string, commit: string): Promise<string[]> {
  return (await git(cwd, ["show", "--name-only", "--format=", commit])).split("\n").filter((l) => l.trim());
}

export async function showFile(cwd: string, commit: string, filePath: string): Promise<Buffer> {
  try {
    return await execFileAsync("git", ["show", `${commit}:${filePath}`], { cwd, env: GIT_ENV, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout as unknown as Buffer);
  } catch (error) {
    const e = error as { stderr?: Buffer };
    throw new GitError(e.stderr?.toString().trim() || "git show failed");
  }
}

export const lsTree = async (cwd: string, commit: string) => (await git(cwd, ["ls-tree", "-r", "--name-only", commit])).split("\n").filter(Boolean);

export async function diff(cwd: string, a: string, b: string): Promise<{ patch: string; files: string[] }> {
  const patch = await git(cwd, ["diff", "--no-color", a, b]);
  const files = (await git(cwd, ["diff", "--name-only", a, b])).split("\n").filter(Boolean);
  return { patch, files };
}

export const bundleCreate = (cwd: string, dest: string) => git(cwd, ["bundle", "create", dest, "--all"]);

export async function cloneBundle(bundle: string, dest: string, cwd: string): Promise<void> {
  await git(cwd, ["clone", "-q", bundle, dest]);
  await setIdentity(dest);
}

export async function cloneLocal(src: string, dest: string, cwd: string): Promise<void> {
  await git(cwd, ["clone", "-q", "--no-hardlinks", src, dest]);
  await setIdentity(dest);
}

export const fetchFrom = (cwd: string, source: string) => git(cwd, ["fetch", "-q", source, "+refs/heads/*:refs/remotes/other/*"]);

export async function resetHard(cwd: string, commit: string): Promise<void> {
  await git(cwd, ["reset", "-q", "--hard", commit]);
  await git(cwd, ["clean", "-qfd"]);
}

export const commitExists = async (cwd: string, commit: string) => (await git(cwd, ["cat-file", "-t", commit], { check: false })).trim() === "commit";
export const rootCommit = async (cwd: string) => (await git(cwd, ["rev-list", "--max-parents=0", "HEAD"])).split(/\s+/)[0]!;
