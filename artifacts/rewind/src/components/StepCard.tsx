import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Step } from '../api'
import { mergeStep } from '../lib/cache'
import { useAuth } from '../store'
import { KIND_COLOR, KIND_LABEL, fmtTokens, parseArgs, shortHash, summarizeCall } from '../lib/steps'
import Prose from './Prose'

function Args({ args }: { args: Record<string, unknown> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[12px]">
      {Object.entries(args).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted mono">{k}</dt>
          <dd className="mono whitespace-pre-wrap break-words text-ink">{typeof v === 'string' ? v : JSON.stringify(v, null, 2)}</dd>
        </div>
      ))}
    </dl>
  )
}

function NoteEditor({ step }: { step: Step }) {
  const key = useAuth((s) => s.key)
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const readOnly = stats.data?.read_only === true
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(step.note ?? '')
  useEffect(() => { setDraft(step.note ?? ''); setEditing(false) }, [step.id, step.note])
  const save = useMutation({
    mutationFn: (note: string | null) => api.setNote(step.branch_id, step.index, note),
    onSuccess: (updated) => { qc.setQueryData<Step[]>(['steps', step.branch_id], (old) => mergeStep(old, updated)); setEditing(false) },
  })
  if (!editing) {
    return (
      <div className="flex items-start gap-2 px-4 py-1.5 border-b border-line text-[12px]">
        {step.note ? <p className="text-ink whitespace-pre-wrap flex-1"><span className="text-accent mr-1.5">note</span>{step.note}</p> : <span className="text-faint flex-1">No note on this step.</span>}
        {key && !readOnly && <button className="text-[11px] text-muted hover:text-ink shrink-0" onClick={() => setEditing(true)}>{step.note ? 'Edit note' : 'Add note'}</button>}
      </div>
    )
  }
  return (
    <form className="px-4 py-2 border-b border-line space-y-1.5" onSubmit={(e) => { e.preventDefault(); save.mutate(draft.trim() || null) }}>
      <textarea className="field min-h-[48px]" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Why this step matters, or what to try from here" autoFocus
        onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false); if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save.mutate(draft.trim() || null) }} />
      <div className="flex gap-2 items-center">
        <button className="btn btn-accent" disabled={save.isPending}>Save note</button>
        <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
        {step.note && <button type="button" className="btn ml-auto" onClick={() => save.mutate(null)}>Remove</button>}
        {save.error && <span className="text-[11px] text-bad">{(save.error as Error).message}</span>}
      </div>
    </form>
  )
}

export default function StepCard({ step, onOpenContext }: { step: Step; onOpenContext: () => void }) {
  const color = KIND_COLOR[step.kind]
  return (
    <article className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 sm:px-4 py-2 border-b border-line text-[11px] text-muted">
        <span className="flex items-center gap-1.5 text-ink">
          <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
          {KIND_LABEL[step.kind]}
        </span>
        {step.kind === 'assistant' && (
          <span className="mono flex gap-3 whitespace-nowrap"><span>{fmtTokens(step.input_tokens)} in</span><span>{fmtTokens(step.output_tokens)} out</span><span className="hidden xl:inline">{step.latency_ms} ms</span></span>
        )}
        {step.kind === 'tool_result' && step.latency_ms > 0 && <span className="mono">{step.latency_ms} ms</span>}
        {step.commit_hash && (
          <span className="mono" title={step.commit_hash}>commit {shortHash(step.commit_hash)}</span>
        )}
        {step.files_changed.length > 0 && (
          <span className="mono truncate">{step.files_changed.join(', ')}</span>
        )}
        <button className="btn ml-auto" onClick={onOpenContext} title="Show the messages the model saw at this step">Context</button>
      </header>
      <NoteEditor step={step} />
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {step.kind === 'user' && (
          <p className="whitespace-pre-wrap text-[13px] leading-relaxed max-w-[70ch]">{String(step.content.content ?? '')}</p>
        )}
        {step.kind === 'assistant' && (
          <div className="space-y-3">
            {step.content.content ? (
              <Prose text={String(step.content.content)} />
            ) : (
              <p className="text-muted text-[12px]">No text. The model replied with tool calls only.</p>
            )}
            {(step.content.tool_calls ?? []).length > 0 && (
              <ul className="space-y-1.5">
                {(step.content.tool_calls ?? []).map((tc) => (
                  <li key={tc.id} className="mono text-[12px] flex gap-2">
                    <span style={{ color: KIND_COLOR.tool_call }}>▸</span>
                    <span>{summarizeCall(tc.function.name, parseArgs(tc))}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {step.kind === 'tool_call' && (
          <div className="space-y-3">
            <div className="mono text-[13px]" style={{ color }}>{step.tool_name}</div>
            <Args args={step.tool_args ?? {}} />
          </div>
        )}
        {step.kind === 'tool_result' && (
          <div className="space-y-3">
            <div className="mono text-[12px] text-muted">{summarizeCall(step.tool_name ?? '', step.tool_args)}</div>
            <pre className="mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words rounded border border-line bg-bg p-3 max-h-full">
              {step.tool_result ?? ''}
            </pre>
          </div>
        )}
      </div>
    </article>
  )
}
