/** Import this first in every test: points the code at a dedicated database and temp dirs. */
import os from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";

const base = path.join(os.tmpdir(), "rewind-ts-tests");
mkdirSync(base, { recursive: true });
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:rewind@localhost:5432/rewind_ts_test";
process.env.DATA_DIR = path.join(base, "data");
process.env.BRANCHES_ROOT = path.join(base, "branches");
process.env.RESTORE_ROOT = path.join(base, "restores");
process.env.REWIND_ACCESS_KEY = "test-key";
process.env.OPENROUTER_API_KEY = "";
// tests run from artifacts/api-server (pnpm test); the bundle lives in test/.generated
process.env.SEED_REPOS_DIR = path.resolve(process.cwd(), "../../seed_repos");
process.env.LOG_LEVEL = "silent";
process.env.NODE_ENV = "production";
