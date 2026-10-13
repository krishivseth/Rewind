// Imported first so a local .env is loaded before any module reads process.env. Replit and Docker
// inject real environment variables and have no .env, in which case this is a no-op.
import { existsSync } from "node:fs";
import path from "node:path";

let dir = import.meta.dirname ?? process.cwd();
for (let i = 0; i < 8; i += 1) {
  const candidate = path.join(dir, ".env");
  if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
    if (existsSync(candidate)) {
      try { process.loadEnvFile?.(candidate); } catch { /* unreadable .env: ignore */ }
    }
    break;
  }
  const parent = path.dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
export {};
