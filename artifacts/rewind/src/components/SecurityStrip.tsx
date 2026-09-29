import type { Step } from '../api'
import { LEVEL_COLOR, reasonLabel, securitySummary } from '../lib/classification'
import { summarizeCall } from '../lib/steps'

/**
 * One line under the scrubber that answers "is anything wrong with this run?" before the user
 * touches a single step. Silent until the first verdict exists; red only when a step is flagged.
 */
export default function SecurityStrip({ steps, index, onJump }: { steps: Step[]; index: number; onJump: (i: number) => void }) {
  const s = securitySummary(steps)
  if (s.classified === 0 && s.pending === 0) return null
  const tone = s.flagged.length ? 'flag' : s.watched.length ? 'watch' : 'none'
  const bg = tone === 'flag' ? 'var(--color-bad-dim)' : tone === 'watch' ? 'var(--color-warn-dim)' : 'transparent'
  const headline = s.flagged.length
    ? `${s.flagged.length} flagged ${s.flagged.length === 1 ? 'step' : 'steps'}`
    : s.watched.length
      ? `${s.watched.length} external ${s.watched.length === 1 ? 'effect' : 'effects'}, none flagged`
      : s.pending ? 'Checking tool results…' : 'No flags'
  const chips = [...s.flagged.map((x) => ({ x, l: 'flag' as const })), ...s.watched.map((x) => ({ x, l: 'watch' as const }))]
    .sort((a, b) => a.x.index - b.x.index)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 text-[12px]" style={{ background: bg }} role="status">
      <span className="flex items-center gap-1.5 shrink-0" style={{ color: tone === 'none' ? 'var(--color-good)' : LEVEL_COLOR[tone] }}>
        <span className="inline-block h-2 w-2" style={{ background: 'currentColor' }} />
        <span className="text-ink">{headline}</span>
      </span>
      {chips.map(({ x, l }) => {
        const c = x.classification!
        const label = c.reasons.length ? c.reasons.map(reasonLabel).join(', ') : 'external effect'
        const active = x.index === index
        return (
          <button
            key={x.id}
            type="button"
            onClick={() => onJump(x.index)}
            className="mono text-[11px] px-1.5 py-0.5 border transition-colors"
            style={{ borderColor: LEVEL_COLOR[l], color: active ? 'var(--color-bg)' : LEVEL_COLOR[l], background: active ? LEVEL_COLOR[l] : 'transparent' }}
            title={`Go to step ${x.index}`}
          >
            #{x.index} {summarizeCall(x.tool_name ?? '', x.tool_args).slice(0, 44)}: {label}
          </button>
        )
      })}
      <span className="ml-auto mono text-[11px] text-faint shrink-0">
        {s.classified} results checked by rules and Jev{s.pending ? `, ${s.pending} pending` : ''}{s.errors ? `, ${s.errors} classifier errors` : ''}
      </span>
    </div>
  )
}
