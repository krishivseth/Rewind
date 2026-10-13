import type { Step } from '../api'
import { parseArgs } from './steps'

/** What a step "did", ignoring output and timing, so two trajectories can be compared tick by tick. */
export function stepSignature(s: Step): string {
  switch (s.kind) {
    case 'user': return `user:${s.content.content ?? ''}`
    case 'assistant': {
      const calls = s.content.tool_calls ?? []
      if (calls.length === 0) return 'assistant:final'
      return 'assistant:' + calls.map((c) => `${c.function.name}(${stableArgs(parseArgs(c))})`).join(',')
    }
    case 'tool_call': return `call:${s.tool_name}(${stableArgs(s.tool_args ?? {})})`
    case 'tool_result': return `result:${s.tool_name}:${s.commit_hash ? 'commit' : 'nocommit'}:${(s.tool_result ?? '').startsWith('error:') ? 'error' : 'ok'}`
  }
}

function stableArgs(a: Record<string, unknown>): string {
  return Object.keys(a).sort().map((k) => `${k}=${typeof a[k] === 'string' ? (a[k] as string).slice(0, 200) : JSON.stringify(a[k])}`).join(';')
}

/**
 * First step index after `fromIndex` where the trajectories stop agreeing, or null if they never
 * diverge (identical, or one is a prefix of another with all shared steps equal... which counts as
 * divergence at the shorter one's end).
 */
export function firstDivergence(trajectories: Step[][], fromIndex: number): number | null {
  if (trajectories.length < 2) return null
  const longest = Math.max(...trajectories.map((t) => t.length))
  for (let i = fromIndex + 1; i < longest; i++) {
    const sigs = trajectories.map((t) => (t[i] ? stepSignature(t[i]) : '∅'))
    if (new Set(sigs).size > 1) return i
  }
  return null
}

/** Clamp a requested step; null means "follow the latest" and stays null only while live. */
export function resolveStep(requested: number | null, lastIndex: number, live: boolean): { index: number; stored: number | null } {
  if (lastIndex < 0) return { index: 0, stored: null }
  const clamped = Math.max(0, Math.min(lastIndex, requested ?? lastIndex))
  return { index: clamped, stored: clamped === lastIndex && live ? null : clamped }
}
