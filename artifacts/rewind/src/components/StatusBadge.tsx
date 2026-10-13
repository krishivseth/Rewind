import type { Branch } from '../api'

const STYLE: Record<Branch['status'], { color: string; label: string }> = {
  queued: { color: 'var(--color-muted)', label: 'queued' },
  running: { color: 'var(--color-accent)', label: 'running' },
  done: { color: 'var(--color-good)', label: 'done' },
  failed: { color: 'var(--color-bad)', label: 'failed' },
  cancelled: { color: 'var(--color-muted)', label: 'cancelled' },
}

export default function StatusBadge({ branch, compact = false }: { branch: Pick<Branch, 'status' | 'queue_position' | 'stop_reason'>; compact?: boolean }) {
  const paused = branch.status === 'done' && branch.stop_reason && branch.stop_reason !== 'completed'
  const s = paused ? { color: 'var(--color-k-call)', label: 'paused' } : STYLE[branch.status]
  const text = branch.status === 'queued' && branch.queue_position ? `queued #${branch.queue_position}` : s.label
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: s.color }} title={text}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${branch.status === 'running' ? 'pulse' : ''}`} style={{ background: s.color }} />
      {!compact && text}
    </span>
  )
}
