import type { Step, StepKind, ToolCall } from '../api'

export const KIND_COLOR: Record<StepKind, string> = {
  user: 'var(--color-k-user)',
  assistant: 'var(--color-k-assistant)',
  tool_call: 'var(--color-k-call)',
  tool_result: 'var(--color-k-result)',
}
export const KIND_LABEL: Record<StepKind, string> = {
  user: 'task', assistant: 'model', tool_call: 'call', tool_result: 'result',
}

export function parseArgs(tc: ToolCall): Record<string, unknown> {
  try { return JSON.parse(tc.function.arguments) } catch { return { _raw: tc.function.arguments } }
}

/** One-line summary of a tool call for ticks, tree nodes and cards. */
export function summarizeCall(name: string, args: Record<string, unknown> | null): string {
  if (!args) return name
  if (name === 'run') return `run ${String(args.command ?? '')}`
  const path = String(args.path ?? '')
  return `${name} ${path}`
}

export function stepTitle(s: Step): string {
  switch (s.kind) {
    case 'user': return 'Task'
    case 'assistant': {
      const calls = s.content.tool_calls ?? []
      return calls.length ? `Model → ${calls.map(c => c.function.name).join(', ')}` : 'Model reply'
    }
    case 'tool_call': return summarizeCall(s.tool_name ?? '', s.tool_args)
    case 'tool_result': return `${summarizeCall(s.tool_name ?? '', s.tool_args)} → result`
  }
}

export const shortHash = (h: string | null | undefined) => (h ? h.slice(0, 8) : '')
export const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))
export const shortModel = (id: string) => id.split('/').pop() ?? id

export function fmtDuration(startIso: string, endIso: string | null): string {
  const end = endIso ? new Date(endIso).getTime() : Date.now()
  const s = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export const fmtCost = (usd: number | undefined) => (usd === undefined ? '' : usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`)

export const STOP_LABEL: Record<string, string> = {
  call_limit: 'paused at the call limit', loop: 'paused: repeating itself', token_budget: 'paused at the token budget',
  wall_clock: 'paused at the time limit', provider_error: 'model provider error', crash: 'internal error', cancelled: 'cancelled',
}
export const isSoftStop = (r: string | null | undefined) => r === 'call_limit' || r === 'loop' || r === 'token_budget' || r === 'wall_clock'
