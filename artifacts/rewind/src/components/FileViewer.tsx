import Editor, { DiffEditor } from '@monaco-editor/react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api'
import { EDITOR_OPTIONS, languageFor } from '../monaco'
import '../monaco'
import { shortHash } from '../lib/steps'

interface Props { branchId: string; index: number; path: string | null; diff: boolean; onToggleDiff: () => void; changedHere: boolean }

export default function FileViewer({ branchId, index, path, diff, onToggleDiff, changedHere }: Props) {
  const q = useQuery({
    queryKey: ['file', branchId, index, path],
    queryFn: () => api.file(branchId, index, path!),
    enabled: !!path,
  })
  if (!path) {
    return <div className="flex flex-1 items-center justify-center text-[12px] text-muted">Select a file to view it at this step.</div>
  }
  const f = q.data
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="pane-title">
        <span className="mono text-ink truncate">{path}</span>
        {f && <span className="mono text-faint">{shortHash(f.commit)}</span>}
        <label className={`ml-auto flex items-center gap-1.5 text-[11px] ${changedHere ? 'text-ink' : 'text-muted'}`} title="Show the change this step made to the file">
          <input type="checkbox" checked={diff} onChange={onToggleDiff} className="accent-[var(--color-accent)]" />
          Diff vs previous step
        </label>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0">
        {q.isLoading && <p className="p-3 text-[12px] text-muted">Loading…</p>}
        {q.error && <p className="p-3 text-[12px] text-bad">{(q.error as Error).message}</p>}
        {f && f.binary && <p className="p-3 text-[12px] text-muted">Binary file, {Math.round(f.content.length * 0.75)} bytes.</p>}
        {f && !f.binary && !diff && (
          <Editor height="100%" theme="rewind" language={languageFor(path)} value={f.content} options={EDITOR_OPTIONS} />
        )}
        {f && !f.binary && diff && (
          f.previous_content == null && f.content ? (
            <div className="flex h-full flex-col">
              <p className="px-3 py-1.5 text-[11px] text-muted border-b border-line">File does not exist at the previous step. Showing it as new.</p>
              <div className="min-h-0 flex-1">
                <DiffEditor height="100%" theme="rewind" language={languageFor(path)} original="" modified={f.content}
                  options={{ ...EDITOR_OPTIONS, renderSideBySide: false, renderOverviewRuler: false }} />
              </div>
            </div>
          ) : (
            <DiffEditor height="100%" theme="rewind" language={languageFor(path)} original={f.previous_content ?? ''} modified={f.content}
              options={{ ...EDITOR_OPTIONS, renderSideBySide: false, renderOverviewRuler: false }} />
          )
        )}
        </div>
      </div>
    </div>
  )
}
