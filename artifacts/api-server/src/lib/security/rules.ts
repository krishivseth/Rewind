/** Deterministic checks on a tool call and its result. No model, no I/O. */
import path from "node:path";

export const RULE_REASONS = ["egress", "secret_path", "path_escape", "instruction_phrase"] as const;

const EGRESS = /(?:^|[\s;&|(`])(?:curl|wget|nc|ncat|netcat|ssh|scp|sftp|rsync|npx)\b|(?:^|[\s;&|(`])(?:pip3?|uv pip|npm|pnpm|yarn|cargo|go)\s+(?:install|add|get)\b|https?:\/\//i;
const SECRET = /(?:^|[\s\/'"@=])(?:\.env(?:\.[\w-]+)?|id_(?:rsa|ed25519|ecdsa|dsa)|[\w.-]+\.pem|credentials(?:\.json)?|\.npmrc|\.netrc|\.pypirc)(?:$|[\s'"|;&)])|(?:^|[\s\/'"@=])\.(?:aws|ssh)(?:\/|$|[\s'"|;&)])/i;
const INSTRUCTION = /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|you\s+must\s+now\b|do\s+not\s+mention\b|note\s+to\s+(?:the\s+)?(?:ai|assistant|agent|llm)s?\b/i;
const PATH_KEYS = ["filePath", "path", "file", "target"];
const COMMAND_KEYS = ["command", "cmd"];

const strings = (args: Record<string, unknown>, keys: string[]) =>
  keys.map((k) => args[k]).filter((v): v is string => typeof v === "string" && v.length > 0);

function escapes(p: string, projectDir: string | null): boolean {
  if (p.split(/[\\/]/).includes("..")) return true;
  if (!projectDir || !path.isAbsolute(p)) return false;
  const rel = path.relative(path.resolve(projectDir), path.resolve(p));
  return rel.startsWith("..") || path.isAbsolute(rel);
}

const commandPaths = (cmd: string) =>
  cmd.split(/[\s|;&<>()`]+/).filter((tok) => tok.length > 1 && (tok.startsWith("/") || tok.startsWith("~") || tok.startsWith(".")));

export function ruleReasons(toolName: string, args: Record<string, unknown> | null, result: string | null, projectDir: string | null): string[] {
  const a = args ?? {};
  const reasons = new Set<string>();
  for (const cmd of strings(a, COMMAND_KEYS)) {
    if (EGRESS.test(cmd)) reasons.add("egress");
    if (SECRET.test(cmd)) reasons.add("secret_path");
    for (const tok of commandPaths(cmd)) if (tok.startsWith("/") && escapes(tok, projectDir)) reasons.add("path_escape");
  }
  for (const p of strings(a, PATH_KEYS)) {
    if (SECRET.test(p)) reasons.add("secret_path");
    if (escapes(p, projectDir)) reasons.add("path_escape");
  }
  if (result && INSTRUCTION.test(result)) reasons.add("instruction_phrase");
  return [...reasons].sort();
}
