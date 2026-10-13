/** Request shapes for the OpenCode server API, checked against a fake fetch. */
import "./setup";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenCodeClient, writeOpencodeConfig } from "../src/lib/opencode/client";

type Call = [string, string, unknown];
function fakeFetch(log: Call[], reply: (p: string) => Response): typeof fetch {
  return async (url, init) => {
    const u = new URL(String(url));
    log.push([init?.method ?? "GET", u.pathname, init?.body ? JSON.parse(String(init.body)) : null]);
    return reply(u.pathname);
  };
}
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("create, prompt, fork, revert shapes", async () => {
  const log: Call[] = [];
  const c = new OpenCodeClient("http://oc", fakeFetch(log, (p) => {
    if (p === "/session") return json({ id: "ses_new" });
    if (p.endsWith("/fork")) return json({ id: "ses_fork" });
    if (p.endsWith("/prompt_async")) return new Response(null, { status: 204 });
    return json({});
  }));
  assert.equal(await c.createSession("t"), "ses_new");
  await c.promptAsync("ses_new", "hello");
  await c.promptAsync("ses_new", null);
  assert.equal(await c.fork("ses_new", "msg_3"), "ses_fork");
  await c.revert("ses_fork", "msg_2", "prt_9");
  await c.revert("ses_fork", "msg_2", null);
  assert.deepEqual(log, [
    ["POST", "/session", { title: "t" }],
    ["POST", "/session/ses_new/prompt_async", { parts: [{ type: "text", text: "hello" }] }],
    ["POST", "/session/ses_new/prompt_async", { parts: [] }],
    ["POST", "/session/ses_new/fork", { messageID: "msg_3" }],
    ["POST", "/session/ses_fork/revert", { messageID: "msg_2", partID: "prt_9" }],
    ["POST", "/session/ses_fork/revert", { messageID: "msg_2" }],
  ]);
});

test("events parses SSE data lines", async () => {
  const body = 'data: {"type":"server.connected","properties":{}}\n\n: keepalive\n\ndata: {"type":"session.idle","properties":{"sessionID":"s"}}\n\n';
  const c = new OpenCodeClient("http://oc", async (url) => {
    assert.equal(new URL(String(url)).pathname, "/event");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  const got: string[] = [];
  for await (const e of c.events()) got.push(e.type);
  assert.deepEqual(got, ["server.connected", "session.idle"]);
});

test("errors surface as OpenCodeError", async () => {
  const c = new OpenCodeClient("http://oc", async () => new Response("nope", { status: 500 }));
  await assert.rejects(() => c.createSession("t"), /500/);
});

test("opencode.json is written", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rewind-occfg-"));
  await writeOpencodeConfig(dir, "deepseek/deepseek-v4-flash");
  const cfg = JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.model, "openrouter/deepseek/deepseek-v4-flash");
  assert.equal(cfg.snapshot, false);
  assert.deepEqual(cfg.compaction, { auto: false });
  assert.deepEqual(cfg.permission, { edit: "allow", bash: "allow", webfetch: "deny" });
});

test("an existing opencode.json keeps its own keys; ours win where they overlap", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "rewind-occfg-"));
  writeFileSync(path.join(dir, "opencode.json"), JSON.stringify({ theme: "dark", mcp: { fs: { command: "x" } }, snapshot: true, permission: { bash: "ask", webfetch: "allow", other: "ask" } }));
  await writeOpencodeConfig(dir, "m");
  const cfg = JSON.parse(readFileSync(path.join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.theme, "dark");
  assert.deepEqual(cfg.mcp, { fs: { command: "x" } });
  assert.equal(cfg.snapshot, false);
  assert.deepEqual(cfg.permission, { other: "ask", edit: "allow", bash: "allow", webfetch: "deny" });
});

test("every request carries the server password as basic auth", async () => {
  const seen: string[] = [];
  const c = new OpenCodeClient("http://oc", async (url, init) => {
    seen.push(`${new URL(String(url)).pathname} ${new Headers(init?.headers).get("authorization") ?? "-"}`);
    const p = new URL(String(url)).pathname;
    if (p === "/session") return json({ id: "s" });
    if (p === "/event") return new Response("", { status: 200 });
    if (p.endsWith("/message")) return json([]);
    return json({ healthy: true, version: "x" });
  }, "pw");
  await c.health(); await c.createSession("t"); await c.messages("s");
  for await (const _ of c.events()) { /* drain */ }
  const expected = `Basic ${Buffer.from("opencode:pw").toString("base64")}`;
  assert.deepEqual(seen, [`/global/health ${expected}`, `/session ${expected}`, `/session/s/message ${expected}`, `/event ${expected}`]);
});
