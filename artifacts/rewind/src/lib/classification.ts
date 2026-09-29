import type { Classification, Step } from '../api'

/** none: nothing to show. watch: external effect below the flag threshold. flag: flagged. error: classifier failed. */
export type Level = 'none' | 'watch' | 'flag' | 'error'

export const LEVEL_COLOR: Record<Level, string> = {
  none: 'transparent',
  watch: 'var(--color-warn)',
  flag: 'var(--color-bad)',
  error: 'var(--color-faint)',
}

const LABELS: Record<string, string> = {
  egress: 'network egress',
  secret_path: 'secret path',
  path_escape: 'path escape',
  instruction_phrase: 'instruction phrase',
  injection: 'injection (model)',
  severity: 'high severity (model)',
  classifier_error: 'classifier error',
}

export function reasonLabel(r: string): string {
  return LABELS[r] ?? r
}

export function level(c: Classification | null | undefined): Level {
  if (!c) return 'none'
  if (c.flag) return 'flag'
  if (c.reasons.includes('classifier_error')) return 'error'
  if (c.effect === 'external') return 'watch'
  return 'none'
}

const RANK: Record<Level, number> = { none: 0, error: 1, watch: 2, flag: 3 }

export function worstLevel(steps: Step[]): Level {
  return steps.reduce<Level>((w, s) => (RANK[level(s.classification)] > RANK[w] ? level(s.classification) : w), 'none')
}

export interface SecuritySummary {
  classified: number   // tool results with a verdict
  pending: number      // tool results still waiting for one
  flagged: Step[]
  watched: Step[]      // external effect, below the flag threshold
  errors: number
}

/** What the strip under the scrubber shows: every tool result, bucketed. */
export function securitySummary(steps: Step[]): SecuritySummary {
  const results = steps.filter((s) => s.kind === 'tool_result')
  const out: SecuritySummary = { classified: 0, pending: 0, flagged: [], watched: [], errors: 0 }
  for (const s of results) {
    if (!s.classification) { out.pending += 1; continue }
    out.classified += 1
    const l = level(s.classification)
    if (l === 'flag') out.flagged.push(s)
    else if (l === 'watch') out.watched.push(s)
    else if (l === 'error') out.errors += 1
  }
  return out
}

/** Mirrors the server's instruction_phrase rule, so a rule hit can be highlighted in the result text. */
const INSTRUCTION = /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions|you\s+must\s+now\b|do\s+not\s+mention\b|note\s+to\s+(?:the\s+)?(?:ai|assistant|agent|llm)s?\b/i

export function findInstructionPhrase(text: string): { start: number; end: number } | null {
  const m = INSTRUCTION.exec(text)
  return m ? { start: m.index, end: m.index + m[0].length } : null
}

/** The step to fork from so the flagged step never happens: the one before it (the server snaps to a complete round). */
export function forkPointBefore(step: Step): number {
  return Math.max(0, step.index - 1)
}
