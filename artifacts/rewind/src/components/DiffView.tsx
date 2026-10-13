import { DiffEditor } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api, type Branch, type Step } from '../api'
import { shortHash, shortModel } from '../lib/steps'
import { EDITOR_OPTIONS, languageFor } from '../monaco'
import '../monaco'

interface Props {
  a: Branch; aSteps: Step[]; aIndex: number
  b: Branch; bIndex: number | null; onBIndex: (i: number | null) => void
  onExit: () => void
}

/** Two branches, two commits: changed files on the left, Monaco diff on the right. */
export default function DiffView({ a, aSteps, aIndex, b, bIndex, onBIndex, onExit }: Props) {
  const bSteps = useQuery({ queryKey: ['steps', b.id], queryFn: () => api.steps(b.id) })
  const bLast = (bSteps.data?.length ?? 0) - 1
  const bEff = bIndex === null ? bLast : Math.min(bIndex, bLast)
  const refA = `${a.id}:${aIndex}`
  const refB = bEff >= 0 ? `${b.id}:${bEff}` : b.id
  const diff = useQuery({ queryKey: ['diff', refA, refB], queryFn: () => api.diff(refA, refB), enabled: aSteps.length > 0 && bSteps.isSuccess })
  const [file, setFile] = useState<string | null>(null)
  useEffect(() => {
    if (diff.data && (!file || !diff.data.files.includes(file))) setFile(diff.data.files[0] ?? null)
  }, [diff.data, file])

  const left = useQuery({ queryKey: ['file', a.id, aIndex, file], queryFn: () => api.file(a.id, aIndex, file!), enabled: !!file, retry: false })
  const right = useQuery({ queryKey: ['file', b.id, bEff, file], queryFn: () => api.file(b.id, bEff, file!), enabled: !!file && bEff >= 0, retry: false })

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pane-title">
        <span className="text-ink">Diff</span>
        <span className="mono"><span className="text-accent">A</span> {shortModel(a.model_id)} @ {aIndex}{diff.data && <span className="text-faint"> {shortHash(diff.data.a.commit)}</span>}</span>
        <span className="text-faint">vs</span>
        <span className="mono flex items-center gap-1 whitespace-nowrap">
          <span style={{ color: 'var(--color-k-call)' }}>B</span> {shortModel(b.model_id)} @
          <input
            className="field w-14 py-0 px-1 text-[11px] mono" type="number" min={0} max={Math.max(0, bLast)}
            value={bEff < 0 ? '' : bEff}
            onChange={(e) => onBIndex(e.target.value === '' ? null : Number(e.target.value))}
            title="Step of B to compare (defaults to its last step)"
          />
          {bIndex !== null && <button className="btn text-[10px]" onClick={() => onBIndex(null)}>last</button>}
          {diff.data && <span className="text-faint"> {shortHash(diff.data.b.commit)}</span>}
        </span>
        <span className="ml-auto text-faint hidden lg:inline">A follows the scrubber</span>
        <button className="btn" onClick={onExit}>Exit diff <kbd>D</kbd></button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-[220px] shrink-0 border-r border-line overflow-auto">
          <div className="pane-title">Changed files {diff.data && <span className="text-faint">{diff.data.files.length}</span>}</div>
          {diff.isLoading && <p className="px-3 py-2 text-[12px] text-muted">Comparing…</p>}
          {diff.error && <p className="px-3 py-2 text-[12px] text-bad">{(diff.error as Error).message}</p>}
          {diff.data?.files.length === 0 && <p className="px-3 py-2 text-[12px] text-muted">No differences between these two commits.</p>}
          {diff.data?.files.map((f) => (
            <button key={f} className={`block w-full truncate px-3 py-1 text-left mono text-[12px] hover:bg-raised ${file === f ? 'bg-accent-dim text-ink' : 'text-muted'}`} onClick={() => setFile(f)}>{f}</button>
          ))}
        </div>
        <div className="relative min-w-0 flex-1 bg-bg">
          <div className="absolute inset-0">
            {file && (left.isSuccess || left.isError) && (right.isSuccess || right.isError) && (
              <DiffEditor
                height="100%" theme="rewind" language={languageFor(file)}
                original={left.data?.content ?? ''} modified={right.data?.content ?? ''}
                options={{ ...EDITOR_OPTIONS, renderSideBySide: true, renderOverviewRuler: false }}
              />
            )}
            {file && (left.isLoading || right.isLoading) && <p className="p-3 text-[12px] text-muted">Loading…</p>}
            {!file && diff.data && diff.data.files.length > 0 && <p className="p-3 text-[12px] text-muted">Pick a file.</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
