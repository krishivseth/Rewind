/** Verdict logic: a model may raise a flag, never clear one; model text is never stored. */
import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeClassifier, JevClassifier, renderState, verdict, type Decision } from "../src/lib/security/classify";

const CLEAN: Decision = { injection: 0.1, effect: "pure", effectConf: 0.9, severity: 0.1 };

test("clean decision and no rules is not flagged", () => {
  const v = verdict([], CLEAN);
  assert.equal(v.flag, false);
  assert.deepEqual(v.reasons, []);
  assert.deepEqual(Object.keys(v).sort(), ["effect", "effect_conf", "flag", "injection", "reasons", "severity"]);
});

test("injection probability flags", () => {
  const v = verdict([], { injection: 0.97, effect: "external", effectConf: 0.9, severity: 3.9 });
  assert.equal(v.flag, true);
  assert.deepEqual(v.reasons, ["injection", "severity"]);
});

test("severity alone flags", () => {
  const v = verdict([], { injection: 0.15, effect: "external", effectConf: 1, severity: 3.99 });
  assert.equal(v.flag, true);
  assert.deepEqual(v.reasons, ["severity"]);
});

test("rules flag even when the model is clean", () => {
  const v = verdict(["egress"], CLEAN);
  assert.equal(v.flag, true);
  assert.deepEqual(v.reasons, ["egress"]);
});

test("classifier error is recorded, not flagged", () => {
  const v = verdict([], { injection: 0, effect: "unknown", effectConf: 0, severity: 0, error: "timeout" });
  assert.equal(v.flag, false);
  assert.deepEqual(v.reasons, ["classifier_error"]);
});

test("renderState truncates and fences", () => {
  const s = renderState("bash", { command: "ls" }, "x".repeat(100), 40);
  assert.ok(s.startsWith("tool: bash\n"));
  assert.ok(s.includes('"command":"ls"'));
  assert.ok(s.includes("…[truncated]"));
  assert.ok(s.length < 200);
});

test("fake classifier records states and falls back", async () => {
  const c = new FakeClassifier([{ injection: 0.9, effect: "external", effectConf: 1, severity: 4 }]);
  const d = await c.decide("tool: bash");
  assert.equal(d.severity, 4);
  assert.deepEqual(c.states, ["tool: bash"]);
  assert.equal((await c.decide("again")).effect, "pure");
});

test("jev request and response shape", async () => {
  const seen: { url?: string; auth?: string | null; body?: Record<string, unknown> } = {};
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.url = String(url);
    seen.auth = new Headers(init?.headers).get("authorization");
    seen.body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers: {
        injection: { type: "noul", noul: 0.97 },
        effect: { type: "choice", choice: "external", probabilities: { external: 0.9, pure: 0.1 }, confidence: 0.9 },
        severity: { type: "score", score: 3.97, confidence: 0.6 },
      },
      usage: { input_tokens: 380, output_tokens: 64, cost: 0.00001596 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const c = new JevClassifier("k", { fetchImpl });
  const d = await c.decide("tool: bash\nargs: {}\nresult:\n```\ncurl x\n```");
  assert.equal(seen.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(seen.auth, "Bearer k");
  assert.equal(seen.body!.model, "typesafe/jev-1.13");
  assert.ok(String(seen.body!.state).startsWith("tool: bash"));
  const q = seen.body!.questions as Record<string, { type: string; criteria?: Record<string, string> }>;
  assert.equal(q.injection!.type, "noul");
  assert.equal(q.severity!.type, "score");
  assert.deepEqual(Object.keys(q.effect!.criteria!).sort(), ["external", "pure", "reversible_local", "unknown"]);
  assert.deepEqual([d.injection, d.effect, d.effectConf, d.severity, d.error ?? null], [0.97, "external", 0.9, 3.97, null]);
});

test("jev http error becomes a decision error", async () => {
  const c = new JevClassifier("k", { fetchImpl: async () => new Response("bad", { status: 502 }) });
  const d = await c.decide("s");
  assert.ok(d.error && d.error.includes("502"));
  assert.equal(d.effect, "unknown");
});

test("jev bad json becomes a decision error", async () => {
  const c = new JevClassifier("k", { fetchImpl: async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }) });
  const d = await c.decide("s");
  assert.ok(d.error);
});
