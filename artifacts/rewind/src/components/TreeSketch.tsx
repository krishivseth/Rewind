import type { SessionSummary } from '../api'

const COLOR: Record<string, string> = {
  queued: 'var(--color-faint)', running: 'var(--color-accent)', done: 'var(--color-good)',
  failed: 'var(--color-bad)', cancelled: 'var(--color-muted)',
}

/**
 * The session's shape at a glance: one bar per branch, length proportional to its step count,
 * starting at the parent's fork step, coloured by status. Root on top, forks beneath in tree order.
 */
export default function TreeSketch({ branches, width = 220 }: { branches: SessionSummary['branches']; width?: number }) {
  const byId = new Map(branches.map((b) => [b.id, b]))
  const kids = new Map<string | null, typeof branches>()
  for (const b of [...branches].sort((a, c) => (a.fork_step_index ?? -1) - (c.fork_step_index ?? -1))) {
    const p = b.parent_branch_id && byId.has(b.parent_branch_id) ? b.parent_branch_id : null
    kids.set(p, [...(kids.get(p) ?? []), b])
  }
  const rows: { b: (typeof branches)[number]; start: number }[] = []
  const walk = (p: string | null) => {
    for (const b of kids.get(p) ?? []) {
      rows.push({ b, start: b.fork_step_index ?? 0 })
      walk(b.id)
    }
  }
  walk(null)
  const maxSteps = Math.max(1, ...branches.map((b) => b.step_count))
  const rowH = 7, gap = 3, padL = 2
  const H = rows.length * (rowH + gap) - gap
  const x = (steps: number) => padL + (steps / maxSteps) * (width - padL - 2)
  return (
    <svg width={width} height={Math.max(rowH, H)} viewBox={`0 0 ${width} ${Math.max(rowH, H)}`} className="shrink-0" aria-hidden>
      {rows.map(({ b, start }, i) => {
        const y = i * (rowH + gap)
        const x0 = x(start), x1 = Math.max(x0 + 2, x(b.step_count))
        const parentRow = b.parent_branch_id ? rows.findIndex((r) => r.b.id === b.parent_branch_id) : -1
        return (
          <g key={b.id}>
            {parentRow >= 0 && (
              <line x1={x0} y1={parentRow * (rowH + gap) + rowH} x2={x0} y2={y + rowH / 2} stroke="var(--color-line)" strokeWidth="1" />
            )}
            <rect x={x0} y={y} width={x1 - x0} height={rowH} rx="1" fill={COLOR[b.status]} opacity={b.status === 'done' ? 0.85 : 1} className={b.status === 'running' ? 'pulse' : ''} />
          </g>
        )
      })}
    </svg>
  )
}
