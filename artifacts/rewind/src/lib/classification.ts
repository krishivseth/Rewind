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
