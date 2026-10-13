/**
 * The seed repos' tests need `python` with pytest and flask on PATH. We build a venv under DATA_DIR
 * once and prepend its bin to the sandbox PATH. Nix pythons (Replit) often lack ensurepip, so pip
 * is bootstrapped from get-pip.py when the venv comes up without it.
 */
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { settings } from "./config";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
let venvBin: string | null = null;
let lastError: string | null = null;
let inProgress: Promise<string | null> | null = null;

export function sandboxPath(): string {
  const base = process.env.PATH ?? "/usr/bin:/bin";
  return venvBin && !base.split(path.delimiter).includes(venvBin) ? `${venvBin}${path.delimiter}${base}` : base;
}

export const sandboxPythonStatus = () => ({ ready: !!venvBin, bin: venvBin, error: lastError });

const exists = (p: string) => access(p).then(() => true, () => false);

async function run(cmd: string, args: string[], timeout: number): Promise<string> {
  // Replit's workspace pip config points at an internal proxy that deployments cannot resolve;
  // ignore any pip.conf and go to the public index.
  const env = {
    ...process.env,
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_INDEX_URL: process.env.SANDBOX_PIP_INDEX_URL ?? "https://pypi.org/simple",
    PIP_NO_INPUT: "1",
  };
  delete (env as Record<string, string | undefined>).PIP_EXTRA_INDEX_URL;
  const { stdout, stderr } = await execFileAsync(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, env });
  return `${stdout}${stderr}`;
}

async function build(venv: string, py: string): Promise<string> {
  const bin = path.join(venv, "bin");
  const python = path.join(bin, "python");
  if (!(await exists(python))) await run(py, ["-m", "venv", "--without-pip", venv], 120_000);
  const pipOk = async () => run(python, ["-m", "pip", "--version"], 30_000).then(() => true, () => false);
  if (!(await pipOk())) {
    // try the stdlib bootstrap first, then the network one
    await run(python, ["-m", "ensurepip", "--upgrade"], 120_000).catch(() => undefined);
    if (!(await pipOk())) {
      const res = await fetch("https://bootstrap.pypa.io/get-pip.py");
      if (!res.ok) throw new Error(`get-pip.py download failed: ${res.status}`);
      const script = path.join(venv, "get-pip.py");
      await writeFile(script, await res.text());
      await run(python, [script, "--quiet", "--isolated"], 300_000);
    }
    if (!(await pipOk())) throw new Error("could not bootstrap pip into the venv");
  }
  await run(python, ["-m", "pip", "install", "--quiet", "--isolated", "pytest", "flask"], 600_000);
  await run(python, ["-c", "import pytest, flask"], 30_000);
  return bin;
}

export async function ensureSandboxPython(): Promise<string | null> {
  if (venvBin) return venvBin;
  if (inProgress) return inProgress;
  inProgress = (async () => {
    const venv = path.join(settings.dataDir, "sandbox-venv");
    await mkdir(settings.dataDir, { recursive: true });
    const candidates = [process.env.SANDBOX_PYTHON, "python3.12", "python3.11", "python3", "python"].filter((p): p is string => !!p);
    for (const py of candidates) {
      try {
        const bin = await build(venv, py);
        venvBin = bin;
        lastError = null;
        logger.info({ venv, python: py }, "sandbox python ready");
        return bin;
      } catch (error) {
        lastError = `${py}: ${(error as Error).message}`.slice(0, 500);
        logger.warn({ err: error, python: py }, "sandbox venv attempt failed");
      }
    }
    logger.error({ lastError }, "no usable python for the sandbox; run(\"test\") will fail in seed repos");
    return null;
  })().finally(() => { inProgress = null; });
  return inProgress;
}

/** Test hook. */
export function setSandboxBin(bin: string | null): void { venvBin = bin; }
