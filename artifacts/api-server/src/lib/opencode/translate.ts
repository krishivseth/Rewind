/**
 * OpenCode message parts -> Rewind step drafts. Pure; the recorder does the I/O.
 *
 * One OpenCode assistant message is one model call: step-start, reasoning/text, one tool part per
 * call (call and result together), step-finish. A round is emitted at step-finish as an assistant
 * draft followed by tool_call/tool_result pairs, the order Rewind's step model expects.
 */
import { readFileSync } from "node:fs";

export type OcEvent = { type: string; properties?: Record<string, unknown> };
type Part = Record<string, unknown> & { id: string; messageID: string; type: string; sessionID?: string };
type ToolState = { status?: string; input?: Record<string, unknown>; output?: string; error?: string };

export interface Draft {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  content: Record<string, unknown>;
  ocMessageId: string;
  ocPartId: string;
  toolName?: string | null;
  toolArgs?: Record<string, unknown> | null;
  toolResult?: string | null;
  callId?: string | null;
  inputTokens: number;
  outputTokens: number;
}

export function readFixtureEvents(file: string): OcEvent[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5)) as OcEvent);
}

function sessionOf(e: OcEvent): string | undefined {
  const p = e.properties ?? {};
  return (p.sessionID as string | undefined)
    ?? ((p.info as { sessionID?: string } | undefined)?.sessionID)
    ?? ((p.part as { sessionID?: string } | undefined)?.sessionID);
}

export class Translator {
  private roles = new Map<string, string>();
  private parts = new Map<string, Map<string, Part>>();
  private userEmitted = new Set<string>();
  private done: "done" | "failed" | null = null;
  error: string | null = null;

  constructor(private sessionId: string) {}
  get finished(): "done" | "failed" | null { return this.done; }

  feed(event: OcEvent): Draft[] {
    if (sessionOf(event) !== this.sessionId) return [];
    const p = event.properties ?? {};
    if (event.type === "message.updated") {
      const info = p.info as { id: string; role: string };
      this.roles.set(info.id, info.role);
      return [];
    }
    if (event.type === "message.part.updated") {
      const part = p.part as Part;
      const bucket = this.parts.get(part.messageID) ?? new Map<string, Part>();
      bucket.set(part.id, part); // Map keeps first-insertion order, so part order is stable
      this.parts.set(part.messageID, bucket);
      if (part.type === "text" && this.roles.get(part.messageID) === "user" && !this.userEmitted.has(part.messageID)) {
        this.userEmitted.add(part.messageID);
        return [{ kind: "user", content: { role: "user", content: String(part.text ?? "") }, ocMessageId: part.messageID, ocPartId: part.id, inputTokens: 0, outputTokens: 0 }];
      }
      if (part.type === "step-finish") return this.round(part.messageID, part);
      return [];
    }
    if (event.type === "session.idle") this.done = "done";
    else if (event.type === "session.error") {
      const err = (p.error ?? {}) as { name?: string; data?: { message?: string } };
      this.done = "failed";
      this.error = String(err.data?.message ?? err.name ?? "session error");
    }
    return [];
  }

  private round(mid: string, fin: Part): Draft[] {
    const parts = [...(this.parts.get(mid)?.values() ?? [])];
    const text = parts.filter((x) => x.type === "text" && x.text).map((x) => String(x.text)).join("\n");
    const tools = parts.filter((x) => x.type === "tool");
    const toolCalls = tools.map((x) => ({
      id: String(x.callID), type: "function" as const,
      function: { name: String(x.tool), arguments: JSON.stringify(((x.state as ToolState | undefined)?.input) ?? {}) },
    }));
    const msg: Record<string, unknown> = { role: "assistant", content: text || null };
    if (toolCalls.length) msg.tool_calls = toolCalls;
    const tokens = (fin.tokens ?? {}) as { input?: number; output?: number; reasoning?: number };
    const out: Draft[] = [{
      kind: "assistant", content: msg, ocMessageId: mid, ocPartId: fin.id,
      inputTokens: Number(tokens.input ?? 0), outputTokens: Number(tokens.output ?? 0) + Number(tokens.reasoning ?? 0),
    }];
    tools.forEach((x, i) => {
      const st = (x.state ?? {}) as ToolState;
      const result = st.status === "completed" ? (st.output ?? "") : `error: ${st.error ?? "tool failed"}`;
      const args = st.input ?? {};
      const base = { ocMessageId: mid, ocPartId: x.id, toolName: String(x.tool), toolArgs: args, callId: String(x.callID), inputTokens: 0, outputTokens: 0 };
      out.push({ kind: "tool_call", content: toolCalls[i]!, ...base });
      out.push({ kind: "tool_result", content: { role: "tool", tool_call_id: String(x.callID), content: result }, toolResult: result, ...base });
    });
    this.parts.delete(mid); // a message holds exactly one round
    return out;
  }
}
