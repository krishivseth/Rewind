/** Model clients behind one tiny interface, so the loop cannot tell fake from real. */
import { settings } from "./config";
import type { ToolCall } from "./messages";

export interface Completion {
  message: Record<string, unknown> & { role: "assistant"; content: string | null; tool_calls?: ToolCall[] };
  inputTokens: number;
  outputTokens: number;
}

export interface ModelClient {
  complete(model: string, messages: Record<string, unknown>[], tools: unknown[], maxTokens: number): Promise<Completion>;
}

export type ScriptTurn = Array<[string, Record<string, unknown>]> | string;

/** Scripted client: each turn is a list of [tool, args] or a final string. */
export class FakeModelClient implements ModelClient {
  calls: Record<string, unknown>[][] = [];
  private counter = 0;
  constructor(private script: ScriptTurn[]) {}

  async complete(_model: string, messages: Record<string, unknown>[]): Promise<Completion> {
    this.calls.push(messages.map((m) => ({ ...m })));
    const turn = this.script.length ? this.script.shift()! : "Done.";
    if (typeof turn === "string") return { message: { role: "assistant", content: turn }, inputTokens: 10, outputTokens: 5 };
    const tool_calls: ToolCall[] = turn.map(([name, args]) => {
      this.counter += 1;
      return { id: `call_${this.counter}`, type: "function", function: { name, arguments: JSON.stringify(args) } };
    });
    return { message: { role: "assistant", content: null, tool_calls }, inputTokens: 10, outputTokens: 5 };
  }
}

export class OpenRouterClient implements ModelClient {
  private clientPromise: Promise<import("openai").default> | null = null;
  constructor(private apiKey: string, private baseUrl: string, private maxRetries: number) {}

  private async sdk() {
    if (!this.clientPromise) {
      this.clientPromise = import("openai").then(({ default: OpenAI }) => new OpenAI({
        apiKey: this.apiKey, baseURL: this.baseUrl, timeout: 180_000,
        // the SDK retries 408/409/429/5xx and connection errors with backoff; 402 and other 4xx fail at once
        maxRetries: this.maxRetries,
        defaultHeaders: { "HTTP-Referer": "https://github.com/krishivseth/Rewind-debugger", "X-Title": "Rewind" },
      }));
    }
    return this.clientPromise;
  }

  async complete(model: string, messages: Record<string, unknown>[], tools: unknown[], maxTokens: number): Promise<Completion> {
    const client = await this.sdk();
    const resp = await client.chat.completions.create({
      model, messages: messages as never, tools: tools as never, tool_choice: "auto", max_tokens: maxTokens, stream: false,
    });
    const choice = resp.choices[0];
    if (!choice) throw new Error("model returned no choices");
    const raw = choice.message;
    const message: Completion["message"] = { role: "assistant", content: raw.content ?? null };
    if (raw.tool_calls?.length) {
      message.tool_calls = raw.tool_calls
        .filter((tc): tc is Extract<typeof tc, { type: "function" }> => tc.type === "function")
        .map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.function.name, arguments: tc.function.arguments } }));
    }
    return { message, inputTokens: resp.usage?.prompt_tokens ?? 0, outputTokens: resp.usage?.completion_tokens ?? 0 };
  }
}

let defaultClient: ModelClient | null = null;
export function getClient(): ModelClient {
  if (!defaultClient) {
    defaultClient = new OpenRouterClient(settings.openrouterApiKey, settings.openrouterBaseUrl, settings.openrouterMaxRetries);
  }
  return defaultClient;
}
/** Test hook. */
export function setClient(client: ModelClient | null): void { defaultClient = client; }
