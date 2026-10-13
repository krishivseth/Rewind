import type { Branch, SessionDetail, Step } from '../api'

/** Insert or replace a step by index, keeping the list ordered. */
export function mergeStep(list: Step[] | undefined, step: Step): Step[] {
  const cur = list ?? []
  if (cur.some((s) => s.index === step.index)) return cur.map((s) => (s.index === step.index ? step : s))
  return [...cur, step].sort((a, b) => a.index - b.index)
}

/** Bump a branch's step_count when a step arrives past what the session knows. */
export function bumpStepCount(session: SessionDetail | undefined, branchId: string, index: number): SessionDetail | undefined {
  if (!session) return session
  return { ...session, branches: session.branches.map((b) => (b.id === branchId && b.step_count <= index ? { ...b, step_count: index + 1 } : b)) }
}

export function patchBranch(session: SessionDetail | undefined, b: Branch): SessionDetail | undefined {
  if (!session) return session
  return { ...session, branches: session.branches.map((x) => (x.id === b.id ? { ...x, ...b } : x)) }
}

/** "fork 1", "fork 2"... among siblings, by creation order; root branches get no label. */
export function forkLabels(branches: Branch[]): Map<string, string> {
  const out = new Map<string, string>()
  const groups = new Map<string, Branch[]>()
  for (const b of branches) if (b.parent_branch_id) groups.set(b.parent_branch_id, [...(groups.get(b.parent_branch_id) ?? []), b])
  for (const kids of groups.values()) {
    kids.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
    kids.forEach((k, i) => out.set(k.id, `fork ${i + 1}`))
  }
  return out
}
