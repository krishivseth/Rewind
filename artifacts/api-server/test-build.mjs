import path from "node:path";
import { readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const pgEntry = path.resolve(root, "../../lib/db/node_modules/pg/esm/index.mjs");
const outdir = path.join(root, "test/.generated");
await rm(outdir, { recursive: true, force: true });
const tests = (await readdir(path.join(root, "test"))).filter((f) => f.endsWith(".test.ts"));
await build({
  entryPoints: Object.fromEntries(tests.map((f) => [f.replace(/\.ts$/, ""), path.join(root, "test", f)])),
  outdir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", sourcemap: "inline",
  external: ["@google-cloud/storage", "pg-native", "pino", "pino-pretty", "express", "openai", "cors", "pino-http", "compression", "cookie-parser"],
  plugins: [{ name: "external-pg", setup(b) { b.onResolve({ filter: /^pg$/ }, () => ({ path: `./${path.relative(outdir, pgEntry)}`, external: true })); } }],
});
