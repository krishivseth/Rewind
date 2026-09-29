/**
 * Benchmark Rewind's tool-result classifier (rules + Jev) on labelled corpora of tool outputs.
 *
 *   OPENROUTER_API_KEY=... pnpm --filter @workspace/scripts exec tsx ../artifacts/api-server/bench/detector.ts cases.jsonl [--concurrency 8]
 *
 * Input: JSONL rows {id, source, slice, tool, text, label(1=attack), category}. Jev decisions are
 * cached next to the input (<file>.jev.jsonl) so reruns and re-scoring are free. Rules see only the
 * result text here (the corpora carry no tool arguments), so the rule layer is instruction_phrase only.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { JevClassifier, renderState, verdict, type Decision } from "../src/lib/security/classify";
import { ruleReasons } from "../src/lib/security/rules";

interface Row { id: string; source: string; slice: string; tool: string; text: string; label: 0 | 1; category: string }
const file = process.argv[2];
if (!file) { console.error("usage: detector.ts cases.jsonl [--concurrency N] [--limit N]"); process.exit(1); }
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const concurrency = arg("--concurrency", 8);
const limit = arg("--limit", Infinity);
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row).slice(0, limit);
const cachePath = `${file}.jev.jsonl`;
const cache = new Map<string, Decision>();
if (existsSync(cachePath)) for (const l of readFileSync(cachePath, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(l); cache.set(r.id, r.d); }

const key = process.env.OPENROUTER_API_KEY ?? "";
const jev = new JevClassifier(key);
const MAX = Number(process.env.CLASSIFY_MAX_CHARS ?? 24_000);

async function decide(r: Row): Promise<Decision> {
  const hit = cache.get(r.id);
  if (hit && !hit.error) return hit;
  const d = await jev.decide(renderState(r.tool, {}, r.text, MAX));
  cache.set(r.id, d);
  appendFileSync(cachePath, `${JSON.stringify({ id: r.id, d })}\n`);
  return d;
}

// run with bounded concurrency
let next = 0, done = 0, errors = 0;
const t0 = Date.now();
const decisions = new Map<string, Decision>();
async function worker() {
  for (;;) {
    const i = next++;
    if (i >= rows.length) return;
    const r = rows[i]!;
    const d = await decide(r);
    if (d.error) errors += 1;
    decisions.set(r.id, d);
    done += 1;
    if (done % 250 === 0) process.stderr.write(`${done}/${rows.length} (${errors} errors, ${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
}
if (!key && rows.some((r) => !cache.has(r.id))) { console.error("OPENROUTER_API_KEY needed for uncached rows"); process.exit(1); }
await Promise.all(Array.from({ length: concurrency }, worker));
process.stderr.write(`done ${done} rows, ${errors} classifier errors, ${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

// --- scoring -----------------------------------------------------------------------------------
type Scored = Row & { d: Decision; rules: string[]; flag: boolean; modelFlag: boolean; ruleFlag: boolean };
const scored: Scored[] = rows.map((r) => {
  const d = decisions.get(r.id)!;
  const rules = ruleReasons(r.tool, {}, r.text, null);
  const v = verdict(rules, d);
  return { ...r, d, rules, flag: v.flag, ruleFlag: rules.length > 0, modelFlag: !d.error && (d.injection > 0.5 || d.severity >= 3) };
});

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
function rates(xs: Scored[], pred: (s: Scored) => boolean) {
  const pos = xs.filter((s) => s.label === 1), neg = xs.filter((s) => s.label === 0);
  const tp = pos.filter(pred).length, fp = neg.filter(pred).length;
  const tpr = pos.length ? tp / pos.length : NaN, fpr = neg.length ? fp / neg.length : NaN;
  const prec = tp + fp ? tp / (tp + fp) : NaN;
  return { n_pos: pos.length, n_neg: neg.length, tpr, fpr, prec };
}
/** Recall achievable at a given false-positive budget by thresholding one score. */
function tprAtFpr(xs: Scored[], score: (s: Scored) => number, budget: number): number {
  const neg = xs.filter((s) => s.label === 0).map(score).sort((a, b) => b - a);
  if (!neg.length) return NaN;
  const allowed = Math.floor(budget * neg.length);
  const thr = allowed >= neg.length ? -Infinity : neg[allowed]!; // flag strictly above the (allowed+1)-th highest benign score
  const pos = xs.filter((s) => s.label === 1);
  return pos.filter((s) => score(s) > thr).length / pos.length;
}
const sInj = (s: Scored) => (s.d.error ? 0 : s.d.injection);
const sSev = (s: Scored) => (s.d.error ? 0 : s.d.severity / 4);
const sMax = (s: Scored) => Math.max(sInj(s), sSev(s), s.ruleFlag ? 1 : 0);

const slices = [...new Set(scored.map((s) => s.slice))];
console.log("\n=== Rewind classifier: rules + Jev (typesafe/jev-1.13) ===");
console.log("slice | n_pos/n_neg | combined TPR/FPR | rules-only TPR/FPR | model-only TPR/FPR | TPR@FPR0% | TPR@FPR1% | TPR@FPR5% (max of injection, severity/4, rule)");
for (const sl of [...slices, "ALL"]) {
  const xs = sl === "ALL" ? scored : scored.filter((s) => s.slice === sl);
  const c = rates(xs, (s) => s.flag), r = rates(xs, (s) => s.ruleFlag), m = rates(xs, (s) => s.modelFlag);
  console.log(`${sl} | ${c.n_pos}/${c.n_neg} | ${pct(c.tpr)}/${pct(c.fpr)} | ${pct(r.tpr)}/${pct(r.fpr)} | ${pct(m.tpr)}/${pct(m.fpr)} | ${pct(tprAtFpr(xs, sMax, 0))} | ${pct(tprAtFpr(xs, sMax, 0.01))} | ${pct(tprAtFpr(xs, sMax, 0.05))}`);
}
console.log("\n--- by attack category (combined TPR) ---");
const cats = new Map<string, Scored[]>();
for (const s of scored) if (s.label === 1) cats.set(`${s.slice}/${s.category}`, [...(cats.get(`${s.slice}/${s.category}`) ?? []), s]);
for (const [k, xs] of [...cats].sort()) console.log(`${k}: ${xs.filter((s) => s.flag).length}/${xs.length} (${pct(xs.filter((s) => s.flag).length / xs.length)})`);
console.log("\n--- false positives (combined) ---");
for (const s of scored.filter((x) => x.label === 0 && x.flag)) console.log(`${s.id} [${s.category}] inj=${s.d.injection.toFixed(2)} sev=${s.d.severity.toFixed(2)} rules=${s.rules.join(",") || "-"} :: ${s.text.replace(/\s+/g, " ").slice(0, 140)}`);
console.log("\n--- sample misses (combined, first 15) ---");
for (const s of scored.filter((x) => x.label === 1 && !x.flag).slice(0, 15)) console.log(`${s.id} [${s.category}] inj=${s.d.injection.toFixed(2)} sev=${s.d.severity.toFixed(2)} :: ${s.text.replace(/\s+/g, " ").slice(0, 140)}`);
