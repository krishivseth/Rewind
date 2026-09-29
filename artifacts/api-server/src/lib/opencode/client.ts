/** HTTP client for `opencode serve` and a manager that runs one server per project directory. */
import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { settings } from "../config";
import { logger } from "../logger";
import type { OcEvent } from "./translate";

export class OpenCodeError extends Error {}

export class OpenCodeClient {
  constructor(readonly baseUrl: string, private fetchImpl: typeof fetch = fetch) {}

  private async post<T>(p: string, body?: unknown): Promise<T | null> {
    const r = await this.fetchImpl(`${this.baseUrl}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 400) throw new OpenCodeError(`${p} -> ${r.status}: ${(await r.text()).slice(0, 300)}`);
    if (r.status === 204) return null;
    const text = await r.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  async health(): Promise<{ healthy: boolean; version: string }> {
    const r = await this.fetchImpl(`${this.baseUrl}/global/health`);
    if (!r.ok) throw new OpenCodeError(`health ${r.status}`);
    return (await r.json()) as { healthy: boolean; version: string };
  }
  async createSession(title: string): Promise<string> { return (await this.post<{ id: string }>("/session", { title }))!.id; }
  async promptAsync(sessionId: string, text: string | null): Promise<void> {
    await this.post(`/session/${sessionId}/prompt_async`, { parts: text === null ? [] : [{ type: "text", text }] });
  }
  async messages(sessionId: string): Promise<unknown[]> {
    const r = await this.fetchImpl(`${this.baseUrl}/session/${sessionId}/message`);
    if (!r.ok) throw new OpenCodeError(`messages ${r.status}`);
    return (await r.json()) as unknown[];
  }
  async fork(sessionId: string, messageId: string): Promise<string> { return (await this.post<{ id: string }>(`/session/${sessionId}/fork`, { messageID: messageId }))!.id; }
  async revert(sessionId: string, messageId: string, partId: string | null): Promise<void> {
    await this.post(`/session/${sessionId}/revert`, partId ? { messageID: messageId, partID: partId } : { messageID: messageId });
  }

  async *events(signal?: AbortSignal): AsyncGenerator<OcEvent> {
    const r = await this.fetchImpl(`${this.baseUrl}/event`, { signal });
    if (!r.ok || !r.body) throw new OpenCodeError(`event stream ${r.status}`);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += value;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        try { yield JSON.parse(line.slice(5)) as OcEvent; } catch { /* partial or malformed line */ }
      }
    }
  }
}

/** Project-level opencode.json: our model, no OpenCode snapshots or compaction, no prompts. */
export async function writeOpencodeConfig(projectDir: string, modelId: string): Promise<void> {
  const cfg = {
    $schema: "https://opencode.ai/config.json",
    model: `openrouter/${modelId}`,
    snapshot: false,
    compaction: { auto: false },
    permission: { edit: "allow", bash: "allow", webfetch: "deny" },
  };
  await writeFile(path.join(projectDir, "opencode.json"), `${JSON.stringify(cfg, null, 2)}\n`);
}

export class ServerManager {
  private servers = new Map<string, { proc: ChildProcess; client: OpenCodeClient }>();
  constructor(private bin: string, private portBase: number) {}

  async ensure(projectDir: string): Promise<OpenCodeClient> {
    const key = path.resolve(projectDir);
    const live = this.servers.get(key);
    if (live && live.proc.exitCode === null) return live.client;
    const port = this.portBase + this.servers.size;
    const proc = spawn(this.bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: key, stdio: "ignore", env: process.env });
    const client = new OpenCodeClient(`http://127.0.0.1:${port}`);
    for (let i = 0; i < 60; i += 1) {
      try {
        await client.health();
        this.servers.set(key, { proc, client });
        logger.info({ projectDir: key, port, pid: proc.pid }, "opencode serve up");
        return client;
      } catch { await new Promise((r) => setTimeout(r, 500)); }
    }
    proc.kill("SIGKILL");
    throw new OpenCodeError(`opencode serve did not come up on port ${port}`);
  }

  async stopAll(): Promise<void> {
    for (const { proc } of this.servers.values()) if (proc.exitCode === null) proc.kill("SIGTERM");
    this.servers.clear();
  }
}

let defaultManager: ServerManager | null = null;
export function manager(): ServerManager {
  if (!defaultManager) defaultManager = new ServerManager(settings.opencodeBin, settings.opencodePortBase);
  return defaultManager;
}
