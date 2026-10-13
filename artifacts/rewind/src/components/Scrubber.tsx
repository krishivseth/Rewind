import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Step } from '../api'
import { KIND_COLOR, KIND_LABEL, shortHash, stepTitle } from '../lib/steps'

interface Props {
  steps: Step[]
  index: number
  forkStepIndex: number | null
  live: boolean
  onChange: (i: number) => void
  actions?: ReactNode
}

/** One tick per step, coloured by kind. Drag or arrow keys to move. The one loud element on the page. */
export default function Scrubber({ steps, index, forkStepIndex, live, onChange, actions }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [hover, setHover] = useState<{ index: number; x: number } | null>(null)

  const indexFromX = useCallback((clientX: number) => {
    const el = ref.current
    if (!el || steps.length === 0) return null
    const r = el.getBoundingClientRect()
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    return Math.min(steps.length - 1, Math.floor(t * steps.length))
  }, [steps.length])

  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragging.current) { const i = indexFromX(e.clientX); if (i !== null) onChange(i) } }
    const up = () => { dragging.current = false }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
  }, [indexFromX, onChange])

  const current = steps[index]
  return (
    <div className="relative border-b border-line bg-panel px-3 pt-3 pb-1.5 select-none">
      <div
        ref={ref}
        role="slider"
        aria-label="Step"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, steps.length - 1)}
        aria-valuenow={index}
        tabIndex={0}
        className="relative flex h-9 items-end gap-px cursor-ew-resize touch-none"
        onPointerDown={(e) => { dragging.current = true; const i = indexFromX(e.clientX); if (i !== null) onChange(i) }}
        onPointerMove={(e) => { const i = indexFromX(e.clientX); const r = ref.current?.getBoundingClientRect(); if (i !== null && r) setHover({ index: i, x: e.clientX - r.left }) }}
        onPointerLeave={() => setHover(null)}
      >
        {hover && steps[hover.index] && (
          <div
            className="absolute bottom-full mb-1 z-10 pointer-events-none rounded border border-line bg-raised px-2 py-1 text-[11px] shadow-lg whitespace-nowrap"
            style={{ left: Math.min(Math.max(0, hover.x - 60), (ref.current?.clientWidth ?? 400) - 260) }}
          >
            <span className="mono text-ink">step {hover.index}</span>
            <span className="ml-2" style={{ color: KIND_COLOR[steps[hover.index].kind] }}>{KIND_LABEL[steps[hover.index].kind]}</span>
            <span className="ml-2 text-muted">{stepTitle(steps[hover.index]).slice(0, 60)}</span>
            {steps[hover.index].commit_hash && <span className="ml-2 mono text-faint">{shortHash(steps[hover.index].commit_hash)}</span>}
            {steps[hover.index].note && <span className="ml-2 text-accent">note</span>}
          </div>
        )}
        {steps.map((s) => {
          const selected = s.index === index
          const inherited = forkStepIndex !== null && s.index <= forkStepIndex
          const tall = s.kind === 'assistant' ? 22 : s.kind === 'user' ? 22 : s.kind === 'tool_result' && s.commit_hash ? 18 : 12
          return (
            <div
              key={s.id}
              title={`${s.index} · ${stepTitle(s)}`}
              className="relative flex-1 min-w-[3px] flex items-end justify-center"
              style={{ height: '100%' }}
            >
              <div
                className="w-full rounded-[1px] transition-[height] duration-100"
                style={{
                  height: selected ? 30 : tall,
                  background: KIND_COLOR[s.kind],
                  opacity: selected ? 1 : inherited ? 0.35 : 0.75,
                  boxShadow: selected ? `0 0 0 1px var(--color-bg), 0 0 0 2px ${KIND_COLOR[s.kind]}` : undefined,
                }}
              />
              {s.commit_hash && s.kind === 'tool_result' && (
                <span className="absolute -bottom-[3px] h-[3px] w-[3px] rounded-full" style={{ background: 'var(--color-ink)' }} />
              )}
              {s.note && (
                <span className="absolute top-0 h-[3px] w-[5px] rounded-sm" style={{ background: 'var(--color-accent)' }} title={s.note} />
              )}
            </div>
          )
        })}
        {live && <div className="ml-1 mb-1 h-2 w-2 rounded-full pulse shrink-0" style={{ background: 'var(--color-accent)' }} title="running" />}
        {forkStepIndex !== null && steps.length > 0 && (
          <div
            className="absolute top-0 bottom-0 w-px border-l border-dashed border-muted pointer-events-none"
            style={{ left: `${((forkStepIndex + 1) / steps.length) * 100}%` }}
            title={`forked from step ${forkStepIndex}`}
          />
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted mono whitespace-nowrap min-w-0">
        <span className="text-ink shrink-0">step {index} <span className="text-muted">of {Math.max(0, steps.length - 1)}</span></span>
        {current && (
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="inline-block h-1.5 w-1.5 rounded-sm" style={{ background: KIND_COLOR[current.kind] }} />
            {KIND_LABEL[current.kind]}
          </span>
        )}
        {current && <span className="truncate text-faint min-w-0 hidden sm:inline">{stepTitle(current)}</span>}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">{actions}</span>
        <span className="hidden xl:flex gap-2 text-faint shrink-0">
          <span><kbd>←</kbd> <kbd>→</kbd> step</span>
          <span><kbd>Home</kbd> <kbd>End</kbd></span>
          <span><kbd>F</kbd> fork</span>
          <span><kbd>D</kbd> diff</span>
        </span>
      </div>
    </div>
  )
}
