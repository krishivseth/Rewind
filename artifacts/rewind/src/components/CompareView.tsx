import { useQueries, useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api, type Branch, type Step } from '../api'
import { forkLabels } from '../lib/cache'
import { firstDivergence } from '../lib/compare'
import { KIND_COLOR, fmtCost, fmtTokens, shortModel, stepTitle } from '../lib/steps'
import StatusBadge from './StatusBadge'

interface Props {
  parent: Branch
  forks: Branch[]
  all: Branch[]
  onPick: (branchId: string, step: number) => void
  onFork: (branchId: string, step: number) => void
  onExit: () => void
}

const TICK = 14

/** Every fork of one parent, one row each, ticks aligned by step index, first divergence marked. */
export default function CompareView({ parent, forks, all, onPick, onFork, onExit }: Props) {
  const queries = useQueries({ queries: forks.map((f) => ({ queryKey: ['steps', f.id], queryFn: () => api.steps(f.id) })) })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const readOnly = stats.data?.read_only === true
  const trajectories = queries.map((q) => q.data ?? [])
  const ready = queries.every((q) => q.isSuccess)
  const forkAt = forks[0]?.fork_step_index ?? 0
  const labels = useMemo(() => forkLabels(all), [all])
  const divergence = ready ? firstDivergence(trajectories, forkAt) : null
  const longest = Math.max(1, ...trajectories.map((t) => t.length))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pane-title">
        <span className="text-ink">Compare {forks.length} forks of {shortModel(parent.model_id)} from step {forkAt}</span>
        {ready && (
          <span className="ml-2">
            {divergence === null ? 'The forks never diverged.' : <>First divergence at <span className="text-ink mono">step {divergence}</span></>}
          </span>
        )}
        <button className="btn ml-auto" onClick={onExit}>Exit compare <kbd>Esc</kbd></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="p-3 space-y-1 min-w-max">
          {/* shared axis */}
          <div className="flex items-center gap-3">
            <div className="w-[320px] shrink-0" />
            <div className="relative flex" style={{ width: longest * TICK }}>
              {Array.from({ length: longest }).map((_, i) => (
                <div key={i} className="text-[9px] mono text-faint text-center" style={{ width: TICK }}>{i % 5 === 0 ? i : ''}</div>
              ))}
            </div>
          </div>
          {forks.map((f, r) => {
            const steps = trajectories[r]
            return (
              <div key={f.id} className="flex items-center gap-3">
                <div className="w-[320px] shrink-0 flex items-center gap-2 text-[12px] whitespace-nowrap">
                  <StatusBadge branch={f} compact />
                  <span className="mono text-ink">{labels.get(f.id) ?? shortModel(f.model_id)}</span>
                  <span className="mono text-muted truncate">{shortModel(f.model_id)}</span>
                  <span className="mono text-faint ml-auto">{fmtTokens(f.total_input_tokens + f.total_output_tokens)}{f.est_cost_usd ? ` ${fmtCost(f.est_cost_usd)}` : ''}</span>
                </div>
                <div className="relative flex items-end h-6" style={{ width: longest * TICK }}>
                  {steps.map((s: Step) => {
                    const inherited = s.index <= forkAt
                    const isDiv = s.index === divergence
                    return (
                      <button
                        key={s.id}
                        title={`${s.index} · ${stepTitle(s)}`}
                        onClick={() => onPick(f.id, s.index)}
                        className="flex items-end justify-center hover:opacity-100"
                        style={{ width: TICK, height: '100%', opacity: inherited ? 0.3 : 0.85 }}
                      >
                        <span
                          className="block rounded-[1px]"
                          style={{
                            width: TICK - 2, height: s.kind === 'assistant' || s.kind === 'user' ? 18 : s.commit_hash ? 14 : 9,
                            background: KIND_COLOR[s.kind],
                            boxShadow: isDiv ? '0 0 0 1px var(--color-bg), 0 0 0 2px var(--color-ink)' : undefined,
                          }}
                        />
                      </button>
                    )
                  })}
                  {divergence !== null && (
                    <span className="absolute top-0 bottom-0 w-px bg-ink/60 pointer-events-none" style={{ left: divergence * TICK + TICK / 2 }} />
                  )}
                </div>
              </div>
            )
          })}
        </div>
        {ready && divergence !== null && (
          <div className="border-t border-line p-3">
            <p className="text-[12px] text-muted mb-2">At step {divergence}, each fork did:</p>
            <table className="text-[12px] w-full max-w-[900px]">
              <tbody>
                {forks.map((f, r) => {
                  const s = trajectories[r][divergence]
                  return (
                    <tr key={f.id} className="border-t border-line">
                      <td className="py-1.5 pr-3 mono text-ink whitespace-nowrap">{labels.get(f.id) ?? shortModel(f.model_id)}</td>
                      <td className="py-1.5 pr-3 mono">
                        {s ? (
                          <button className="text-left hover:text-accent" onClick={() => onPick(f.id, divergence)}>
                            <span className="inline-block h-1.5 w-1.5 rounded-sm mr-1.5" style={{ background: KIND_COLOR[s.kind] }} />
                            {stepTitle(s)}
                          </button>
                        ) : <span className="text-faint">already finished ({trajectories[r].length} steps)</span>}
                      </td>
                      <td className="py-1.5 text-muted whitespace-nowrap"><StatusBadge branch={f} /> <span className="mono ml-2">{f.step_count} steps</span>{f.est_cost_usd ? <span className="mono ml-2 text-faint">{fmtCost(f.est_cost_usd)}</span> : null}</td>
                      <td className="py-1.5 pl-3">{!readOnly && <button className="btn btn-accent" onClick={() => onFork(f.id, divergence)} title="Fork this branch at the divergence step, with any model">Fork here</button>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
