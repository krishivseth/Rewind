import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { api } from '../api'
import { fmtTokens } from '../lib/steps'

const ROLE_COLOR: Record<string, string> = {
  system: 'var(--color-muted)', user: 'var(--color-k-user)', assistant: 'var(--color-k-assistant)', tool: 'var(--color-k-result)',
}

function MessageCard({ m, i, open }: { m: Record<string, unknown>; i: number; open: boolean }) {
  const role = String(m.role ?? '?')
  const calls = (m.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined) ?? []
  const body = typeof m.content === 'string' ? m.content : m.content == null ? '' : JSON.stringify(m.content, null, 2)
  const summary = body ? body.slice(0, 90).replace(/\s+/g, ' ') : calls.map(c => c.function.name).join(', ')
  return (
    <details className="group border border-line rounded bg-bg" open={open}>
      <summary className="flex items-center gap-2 px-3 py-1.5 cursor-pointer text-[12px] list-none [&::-webkit-details-marker]:hidden">
        <span className="text-faint mono w-6 shrink-0">{i}</span>
        <span className="mono shrink-0" style={{ color: ROLE_COLOR[role] ?? 'var(--color-ink)' }}>{role}</span>
        <span className="truncate text-muted group-open:hidden">{summary}</span>
        <span className="ml-auto text-faint mono shrink-0">{fmtTokens(Math.round((body.length + JSON.stringify(calls).length) / 4))}~</span>
      </summary>
      <div className="px-3 pb-3 space-y-2">
        {body && <pre className="mono text-[12px] whitespace-pre-wrap break-words leading-[1.5]">{body}</pre>}
        {calls.map((c) => (
          <div key={c.id} className="mono text-[12px] border-l-2 pl-2" style={{ borderColor: 'var(--color-k-call)' }}>
            <div className="text-muted">{c.function.name} <span className="text-faint">{c.id}</span></div>
            <pre className="whitespace-pre-wrap break-words">{prettyArgs(c.function.arguments)}</pre>
          </div>
        ))}
        {typeof m.tool_call_id === 'string' && <div className="mono text-[11px] text-faint">for {m.tool_call_id}</div>}
      </div>
    </details>
  )
}

function prettyArgs(s: string) { try { return JSON.stringify(JSON.parse(s), null, 2) } catch { return s } }

export default function ContextDrawer({ branchId, index, onClose }: { branchId: string; index: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['context', branchId, index], queryFn: () => api.context(branchId, index) })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const ctx = q.data
  return (
    <div className="absolute inset-0 z-20 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <aside
        className="relative h-full w-full max-w-[640px] bg-panel border-l border-line flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Model context"
      >
        <div className="pane-title">
          <span className="text-ink">Context at step {ctx?.step_index ?? index}</span>
          {ctx && ctx.step_index !== ctx.requested_index && (
            <span className="text-faint">(step {ctx.requested_index} is a tool call inside this turn)</span>
          )}
          {ctx && (
            <span className="ml-auto mono flex gap-3">
              <span>{ctx.messages.length} messages</span>
              <span>{fmtTokens(ctx.token_count)} tokens{ctx.token_count_source === 'estimated' ? ' (est.)' : ''}</span>
            </span>
          )}
          <button className="btn ml-2" onClick={onClose}>Close <kbd>Esc</kbd></button>
        </div>
        <div className="flex-1 overflow-auto p-3 space-y-2">
          {q.isLoading && <p className="text-muted text-[12px]">Loading…</p>}
          {q.error && <p className="text-bad text-[12px]">Could not load context: {(q.error as Error).message}</p>}
          {ctx?.messages.map((m, i) => <MessageCard key={i} m={m} i={i} open={i >= ctx.messages.length - 2} />)}
        </div>
      </aside>
    </div>
  )
}
