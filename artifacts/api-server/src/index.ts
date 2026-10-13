import "./env";
import { mkdir } from "node:fs/promises";
import app from "./app";
import { settings } from "./lib/config";
import { logger } from "./lib/logger";
import { migrate } from "./lib/migrate";
import { ensureSandboxPython } from "./lib/sandbox-python";
import * as services from "./lib/services";
import { networkIsolationPrefix } from "./lib/tools";
import * as worktree from "./lib/worktree";

const port = Number(process.env.PORT ?? 8080);
if (!Number.isFinite(port) || port <= 0) throw new Error(`Invalid PORT value: "${process.env.PORT}"`);

await migrate();
await mkdir(settings.dataDir, { recursive: true });
await mkdir(settings.branchesRoot, { recursive: true });
const swept = await worktree.sweepRestores();
const reposSeeded = await services.ensureSeedRepos();
const stale = await services.recoverStaleBranches(true);
const netIsolation = await networkIsolationPrefix();
logger.info({ repos: reposSeeded.length, staleFailed: stale, restoresSwept: swept, netIsolation: netIsolation.length ? netIsolation.join(" ") : "off", keyConfigured: !!settings.accessKey, dataDir: settings.dataDir }, "boot");
if (!settings.openrouterApiKey) logger.warn("OPENROUTER_API_KEY is not set; real branches will fail");
void ensureSandboxPython();

setInterval(() => { void worktree.evictStaleRestores(); }, 60_000).unref();
setInterval(() => { void services.recoverStaleBranches(); void services.drainBundleCleanupQueue(); }, 5 * 60_000).unref();

app.listen(port, (err) => {
  if (err) { logger.error({ err }, "Error listening on port"); process.exit(1); }
  logger.info({ port }, "Server listening");
});
