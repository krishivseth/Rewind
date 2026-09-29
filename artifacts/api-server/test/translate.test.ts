/** Parts -> steps against a captured /event stream (three sessions; we follow the first). */
import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { messagesFromSteps, validBoundary, type StepLike } from "../src/lib/messages";
import { Translator, readFixtureEvents, type Draft } from "../src/lib/opencode/translate";

const FIXTURE = path.join(process.cwd(), "test/fixtures/opencode_events.jsonl");
const MAIN = "ses_f1540231effe4QkaJiFInzILu8";
const FORK1 = "ses_f153f3440ffejIpyMNn5pnBjf3";

function run(session = MAIN) {
  const t = new Translator(session);
  const drafts: Draft[] = [];
  for (const e of readFixtureEvents(FIXTURE)) drafts.push(...t.feed(e));
  return { t, drafts };
}
const asSteps = (drafts: Draft[]): StepLike[] => drafts.map((d, i) => ({ stepIndex: i, kind: d.kind, content: d.content, commitHash: null }));

test("counts and order", () => {
  const { t, drafts } = run();
  const kinds = drafts.map((d) => d.kind);
  assert.equal(kinds[0], "user");
  assert.equal(kinds.filter((k) => k === "assistant").length, 9);
  assert.equal(kinds.filter((k) => k === "tool_call").length, 9);
  assert.equal(kinds.filter((k) => k === "tool_result").length, 9);
  assert.equal(drafts.length, 28);
  assert.deepEqual(kinds.slice(1, 6), ["assistant", "tool_call", "tool_result", "tool_call", "tool_result"]);
  assert.equal(t.finished, "done");
  assert.equal(t.error, null);
});

test("only the requested session is followed", () => {
  const { drafts } = run();
  assert.ok(drafts.every((d) => d.ocMessageId.startsWith("msg_")));
  const other = run(FORK1).drafts.length;
  assert.ok(other > 0 && other < 28);
});

test("message shapes are OpenAI-compatible", () => {
  const { drafts } = run();
  const user = drafts[0]!;
  assert.deepEqual(Object.keys(user.content).sort(), ["content", "role"]);
  assert.ok(String(user.content.content).startsWith("Read README.md"));
  const first = drafts[1]!;
  assert.equal(first.content.role, "assistant");
  const calls = first.content.tool_calls as Array<{ id: string; function: { name: string; arguments: string } }>;
  assert.deepEqual(calls.map((c) => c.function.name), ["read", "read"]);
  assert.deepEqual(JSON.parse(calls[0]!.function.arguments), { filePath: "/tmp/ocproj/README.md" });
  const call = drafts[2]!, result = drafts[3]!;
  assert.equal(call.kind, "tool_call");
  assert.deepEqual(call.content, calls[0]);
  assert.equal(call.callId, calls[0]!.id);
  assert.deepEqual(result.content, { role: "tool", tool_call_id: calls[0]!.id, content: result.toolResult });
  assert.ok(result.toolResult!.startsWith("<path>/tmp/ocproj/README.md</path>"));
  assert.equal(result.toolName, "read");
  assert.deepEqual(result.toolArgs, { filePath: "/tmp/ocproj/README.md" });
  assert.equal(first.inputTokens, 11058);
  assert.equal(first.outputTokens, 180 + 17);
});

test("ids point at OpenCode parts", () => {
  const { drafts } = run();
  assert.equal(drafts[1]!.ocMessageId, "msg_0eabfddef001whoxmgqVivmwDR");
  assert.equal(drafts[1]!.ocPartId, "prt_0eabff421001uxTdFEzeZs8Tge"); // its step-finish part
  assert.equal(drafts[2]!.ocPartId, "prt_0eabfee8c001ZVInAalMljPQ66"); // the tool part, for call and result
  assert.equal(drafts[3]!.ocPartId, "prt_0eabfee8c001ZVInAalMljPQ66");
});

test("text-only final round has no tool_calls", () => {
  const last = run().drafts.at(-1)!;
  assert.equal(last.kind, "assistant");
  assert.ok(!("tool_calls" in last.content));
  assert.equal(last.content.content, "All 4 tests pass.");
});

test("result is valid model input at every round boundary", () => {
  const steps = asSteps(run().drafts);
  const msgs = messagesFromSteps("sys", steps);
  assert.equal(msgs[0]!.role, "system");
  assert.equal(msgs[1]!.role, "user");
  assert.deepEqual(msgs.slice(2, 5).map((m) => m.role), ["assistant", "tool", "tool"]);
  // the last tool_result of every round is a valid boundary; a mid-round result snaps back to an earlier one
  const assistants = steps.filter((s) => s.kind === "assistant").map((s) => s.stepIndex);
  for (const [i, a] of assistants.entries()) {
    const roundEnd = (assistants[i + 1] ?? steps.length) - 1;
    if (steps[roundEnd]!.kind === "tool_result") assert.equal(validBoundary(steps, roundEnd), roundEnd);
    else assert.equal(validBoundary(steps, a), a);
  }
  assert.equal(validBoundary(steps, 3), 0); // first of two results in round 1: back to the user message
  assert.equal(validBoundary(steps, 5), 5);
});

test("error tool part becomes an error result", () => {
  const errs = run(FORK1).drafts.filter((d) => d.kind === "tool_result" && d.toolResult!.startsWith("error: "));
  assert.ok(errs.length > 0);
  assert.ok(errs[0]!.toolResult!.includes("Could not find oldString"));
});

test("session.error marks failed", () => {
  const t = new Translator("s");
  t.feed({ type: "session.error", properties: { sessionID: "s", error: { name: "X", data: { message: "boom" } } } });
  assert.equal(t.finished, "failed");
  assert.ok(t.error!.includes("boom"));
});
