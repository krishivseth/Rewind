import { useMutation, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { api, type BenchSample } from '../api'
import AccessKeyPrompt from '../components/AccessKeyPrompt'
import SecurityVerdict from '../components/SecurityVerdict'
import TopBar from '../components/TopBar'
import { LEVEL_COLOR, level } from '../lib/classification'
import { useAuth } from '../store'

const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '')
const SLICE_LABEL: Record<string, string> = {
  agentdojo: 'AgentDojo tool outputs', injecagent: 'InjecAgent tool responses', hard_negatives: 'Hard negatives', 'mcp-guardbench': 'mcp-guardbench (MCP frames)', all: 'All',
}
const OUTCOME: Record<BenchSample['outcome'], { label: string; color: string }> = {
  hit: { label: 'caught', color: 'var(--color-good)' },
  miss: { label: 'missed', color: 'var(--color-bad)' },
  false_positive: { label: 'false positive', color: 'var(--color-warn)' },
  true_negative: { label: 'clean, passed', color: 'var(--color-muted)' },
}

/**
 * The classifier's score sheet: every number comes from one recorded run over public corpora,
 * with the rows behind the numbers, and a box to classify anything live on this server.
 */
export default function Bench() {
  const q = useQuery({ queryKey: ['bench'], queryFn: api.bench })
  const key = useAuth((s) => s.key)
  const [slice, setSlice] = useState('all')
  const [outcome, setOutcome] = useState<BenchSample['outcome'] | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [tool, setTool] = useState('read')
  const [text, setText] = useState('')
  const tryIt = useMutation({ mutationFn: () => api.benchTry(tool, text) })
  const d = q.data
  const samples = useMemo(() => (d?.samples ?? []).filter((s) => (slice === 'all' || s.slice === slice) && (outcome === 'all' || s.outcome === outcome)), [d, slice, outcome])
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of d?.samples ?? []) if (slice === 'all' || s.slice === slice) c[s.outcome] = (c[s.outcome] ?? 0) + 1
    return c
  }, [d, slice])

  return (
    <div className="flex h-full flex-col">
      <TopBar><span className="text-[13px] text-muted hidden sm:inline">Classifier benchmark</span></TopBar>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-[1100px] px-4 py-6 space-y-8">
          {q.isLoading && <p className="text-muted text-[12px]">Loading…</p>}
          {q.error && <p className="text-bad text-[12px]">No benchmark data on this server: {(q.error as Error).message}</p>}
          {d && (
            <>
              <section className="space-y-2">
                <h1 className="text-[18px] text-ink">How the tool-result classifier scores</h1>
                <p className="text-[13px] text-muted max-w-[78ch]">
                  Every tool result Rewind records is checked twice: deterministic rules first, then {d.model}, which returns numbers only.
                  Either can raise a flag; neither can clear one. The run below scored {d.total.toLocaleString()} labelled tool outputs from public
                  corpora with the thresholds as shipped (injection over {d.thresholds.injection}, severity {d.thresholds.severity} of 4), chosen before seeing the data.
                  {d.errors ? ` ${d.errors} classifier errors.` : ' No classifier errors.'} Recorded {new Date(d.generated_at).toLocaleString()}.
                </p>
              </section>

              <section className="space-y-2">
                <h2 className="text-[14px] text-ink">Results by corpus</h2>
                <div className="overflow-x-auto border border-line">
                  <table className="w-full text-[12px]">
                    <thead className="text-muted">
                      <tr className="border-b border-line">
                        <th className="text-left px-3 py-2 font-normal">corpus</th>
                        <th className="text-right px-3 py-2 font-normal">attacks / benign</th>
                        <th className="text-right px-3 py-2 font-normal">caught</th>
                        <th className="text-right px-3 py-2 font-normal">false positives</th>
                        <th className="text-right px-3 py-2 font-normal">rules alone</th>
                        <th className="text-right px-3 py-2 font-normal">Jev alone</th>
                        <th className="text-right px-3 py-2 font-normal" title="recall reachable by retuning one threshold, at zero false positives">caught at 0% FP</th>
                        <th className="text-right px-3 py-2 font-normal">at 1% FP</th>
                      </tr>
                    </thead>
                    <tbody className="mono">
                      {d.slices.map((s) => (
                        <tr key={s.slice} className={`border-b border-line last:border-0 ${s.slice === 'all' ? 'text-ink' : ''}`}>
                          <td className="px-3 py-1.5 font-sans">{SLICE_LABEL[s.slice] ?? s.slice}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.n_pos} / {s.n_neg}</td>
                          <td className="px-3 py-1.5 text-right" style={{ color: s.n_pos ? 'var(--color-good)' : undefined }}>{pct(s.tpr)}</td>
                          <td className="px-3 py-1.5 text-right" style={{ color: s.fpr > 0.05 ? 'var(--color-warn)' : undefined }}>{pct(s.fpr)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.n_pos ? `${pct(s.rules_tpr)} / ${pct(s.rules_fpr)}` : pct(s.rules_fpr)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.n_pos ? `${pct(s.model_tpr)} / ${pct(s.model_fpr)}` : pct(s.model_fpr)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.slice === 'all' || !s.n_pos ? '' : pct(s.tpr_at_fpr0)}</td>
                          <td className="px-3 py-1.5 text-right text-muted">{s.slice === 'all' || !s.n_pos ? '' : pct(s.tpr_at_fpr1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-faint max-w-[78ch]">
                  The corpora carry tool output text only, so the rule layer here is the instruction-phrase rule; in Rewind the egress, secret-path and
                  path-escape rules also see the command and path arguments.
                </p>
              </section>

              <section className="space-y-2">
                <h2 className="text-[14px] text-ink">Against published detectors on the same rows</h2>
                <div className="overflow-x-auto border border-line">
                  <table className="w-full text-[12px]">
                    <thead className="text-muted">
                      <tr className="border-b border-line">
                        <th className="text-left px-3 py-2 font-normal">detector</th>
                        <th className="text-right px-3 py-2 font-normal">AgentDojo caught / FP</th>
                        <th className="text-right px-3 py-2 font-normal">InjecAgent caught / FP</th>
                        <th className="text-right px-3 py-2 font-normal">hard-negative FP</th>
                      </tr>
                    </thead>
                    <tbody className="mono">
                      {d.baselines.map((b) => (
                        <tr key={b.detector} className="border-b border-line text-muted">
                          <td className="px-3 py-1.5 font-sans">{b.detector}</td>
                          <td className="px-3 py-1.5 text-right">{pct(b.agentdojo[0])} / {pct(b.agentdojo[1])}</td>
                          <td className="px-3 py-1.5 text-right">{pct(b.injecagent[0])} / {pct(b.injecagent[1])}</td>
                          <td className="px-3 py-1.5 text-right">{pct(b.hard_negatives_fpr)}</td>
                        </tr>
                      ))}
                      {(() => {
                        const ad = d.slices.find((s) => s.slice === 'agentdojo'), ia = d.slices.find((s) => s.slice === 'injecagent'), hn = d.slices.find((s) => s.slice === 'hard_negatives')
                        return ad && ia && hn ? (
                          <tr className="text-ink" style={{ background: 'var(--color-accent-dim)' }}>
                            <td className="px-3 py-1.5 font-sans">Rewind rules + Jev</td>
                            <td className="px-3 py-1.5 text-right">{pct(ad.tpr)} / {pct(ad.fpr)}</td>
                            <td className="px-3 py-1.5 text-right">{pct(ia.tpr)} / {pct(ia.fpr)}</td>
                            <td className="px-3 py-1.5 text-right">{pct(hn.fpr)}</td>
                          </tr>
                        ) : null
                      })()}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-faint max-w-[78ch]">
                  Baselines are from the corpus authors' own run (chunked inputs). Jev was released two weeks before this run; whether these corpora are in
                  its training data is unknown, and its lower score on the CVE-based mcp-guardbench rows is consistent with some familiarity.
                </p>
              </section>

              <section className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[14px] text-ink mr-2">The rows behind the numbers</h2>
                  <select className="field mono w-auto py-1" value={slice} onChange={(e) => setSlice(e.target.value)}>
                    {['all', ...d.slices.map((s) => s.slice).filter((s) => s !== 'all')].map((s) => <option key={s} value={s}>{SLICE_LABEL[s] ?? s}</option>)}
                  </select>
                  <div className="flex gap-1">
                    {(['all', 'hit', 'miss', 'false_positive', 'true_negative'] as const).map((o) => (
                      <button key={o} type="button" className={`btn ${outcome === o ? 'btn-accent' : ''}`} onClick={() => setOutcome(o)}>
                        {o === 'all' ? 'all' : OUTCOME[o].label}{o !== 'all' && counts[o] ? ` ${counts[o]}` : ''}
                      </button>
                    ))}
                  </div>
                  <span className="ml-auto text-[11px] text-faint">{samples.length} of {d.samples.length} sampled rows. Every false positive is included; hits, misses and clean rows are spread across categories.</span>
                </div>
                <ul className="space-y-1">
                  {samples.map((s) => {
                    const o = OUTCOME[s.outcome]
                    const c = s.classification
                    const isOpen = open === s.id
                    return (
                      <li key={s.id} className="border border-line">
                        <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-raised" onClick={() => setOpen(isOpen ? null : s.id)}>
                          <span className="mono text-[11px] w-[104px] shrink-0" style={{ color: o.color }}>{o.label}</span>
                          <span className="mono text-[11px] text-faint w-[120px] shrink-0 truncate">{s.slice}{s.category ? ` / ${s.category}` : ''}</span>
                          <span className="text-[12px] text-ink truncate min-w-0 flex-1">{s.text.replace(/\s+/g, ' ').slice(0, 160)}</span>
                          <span className="mono text-[11px] shrink-0 flex gap-3" style={{ color: level(c) === 'none' ? 'var(--color-faint)' : LEVEL_COLOR[level(c)] }}>
                            <span>inj {c.injection.toFixed(2)}</span><span>sev {c.severity.toFixed(2)}</span><span>{c.effect}</span>
                          </span>
                        </button>
                        {isOpen && (
                          <div className="border-t border-line px-3 py-3 space-y-3">
                            {level(c) !== 'none'
                              ? <SecurityVerdict c={c} runner={undefined} onFork={() => undefined} hideActions />
                              : <p className="text-[12px] text-muted">Passed: no rule matched and the model scored it below both thresholds.</p>}
                            <pre className="mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words border border-line bg-bg p-3 max-h-[320px] overflow-auto">{s.text}</pre>
                            <button type="button" className="btn" onClick={() => { setTool(s.tool); setText(s.text); document.getElementById('bench-try')?.scrollIntoView({ behavior: 'smooth' }) }}>Classify this live</button>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </section>
            </>
          )}

          <section id="bench-try" className="space-y-3 border-t border-line pt-6">
            <h2 className="text-[14px] text-ink">Classify something on this server</h2>
            <p className="text-[12px] text-muted max-w-[78ch]">Paste any tool output, or pick a row above. The same code path Rewind runs on every recorded step: rules, then one Jev call.</p>
            {!key ? <AccessKeyPrompt compact /> : (
              <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) tryIt.mutate() }}>
                <div className="flex gap-2">
                  <input className="field mono w-40" value={tool} onChange={(e) => setTool(e.target.value)} placeholder="tool name" />
                  <button className="btn btn-accent" disabled={tryIt.isPending || !text.trim()}>{tryIt.isPending ? 'Classifying…' : 'Classify'}</button>
                  {tryIt.data && <span className="mono text-[11px] text-faint self-center">{tryIt.data.ms} ms</span>}
                </div>
                <textarea className="field mono min-h-[140px] resize-y" value={text} onChange={(e) => setText(e.target.value)} placeholder="Tool output text" />
                {tryIt.error && <p className="text-[12px] text-bad">{(tryIt.error as Error).message}</p>}
                {tryIt.data && (level(tryIt.data.classification) !== 'none'
                  ? <SecurityVerdict c={tryIt.data.classification} runner={undefined} onFork={() => undefined} hideActions />
                  : <p className="text-[12px]" style={{ color: 'var(--color-good)' }}>Clean: no rule matched; injection {tryIt.data.classification.injection.toFixed(2)}, severity {tryIt.data.classification.severity.toFixed(2)}, effect {tryIt.data.classification.effect}.</p>)}
              </form>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
