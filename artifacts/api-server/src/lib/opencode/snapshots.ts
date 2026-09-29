/**
 * A Rewind-owned git object database over an OpenCode project directory. GIT_DIR lives under
 * DATA_DIR/snapshots/<session>; GIT_WORK_TREE is the project. The project's own .git is never read
 * or written: it is excluded from every snapshot via info/exclude.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { settings } from "../config";
import * as git from "../gitwrap";

export class SnapshotStore {
  readonly gitDir: string;
  constructor(sessionId: string, readonly projectDir: string, root: string = settings.dataDir) {
    this.gitDir = path.join(root, "snapshots", sessionId);
  }

  private g(args: string[], check = true) {
    return git.git(this.projectDir, ["--git-dir", this.gitDir, "--work-tree", this.projectDir, ...args], { check });
  }

  async init(): Promise<string> {
    await mkdir(path.dirname(this.gitDir), { recursive: true });
    await git.git(path.dirname(this.gitDir), ["init", "-q", "--bare", "-b", "main", this.gitDir]);
    await this.g(["config", "user.name", "Rewind"]);
    await this.g(["config", "user.email", "rewind@localhost"]);
    await this.g(["config", "commit.gpgsign", "false"]);
    await this.g(["config", "core.bare", "false"]);
    await mkdir(path.join(this.gitDir, "info"), { recursive: true });
    await writeFile(path.join(this.gitDir, "info", "exclude"), ".git/\n__pycache__/\n.pytest_cache/\nnode_modules/\n.opencode/\n");
    await this.g(["add", "-A"]);
    await this.g(["commit", "-q", "--allow-empty", "-m", "base"]);
    return (await this.g(["rev-parse", "HEAD"])).trim();
  }

  async isDirty(): Promise<boolean> { return (await this.g(["status", "--porcelain"])).trim().length > 0; }

  async commit(message: string): Promise<string | null> {
    await this.g(["add", "-A"]);
    if (!(await this.g(["status", "--porcelain"])).trim()) return null;
    await this.g(["commit", "-q", "-m", message]);
    return (await this.g(["rev-parse", "HEAD"])).trim();
  }

  async filesChangedIn(commit: string): Promise<string[]> {
    return (await this.g(["show", "--name-only", "--format=", commit])).split("\n").filter((l) => l.trim());
  }

  /** Make the project tree identical to `commit`: tracked files restored, extras removed. */
  async checkout(commit: string): Promise<void> {
    await this.g(["read-tree", "--reset", "-u", commit]);
    await this.g(["clean", "-qfd"]);
    await this.g(["update-ref", "HEAD", commit]);
  }

  async bundle(dest: string): Promise<string> {
    await mkdir(path.dirname(dest), { recursive: true });
    await this.g(["bundle", "create", dest, "--all"]);
    return dest;
  }

  async rootCommit(): Promise<string> { return (await this.g(["rev-list", "--max-parents=0", "HEAD"])).split(/\s+/)[0]!; }
}
