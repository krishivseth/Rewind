import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import type { ReactNode } from 'react'
import { api } from '../api'
import { fmtTokens } from '../lib/steps'

export default function TopBar({ children }: { children?: ReactNode }) {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats, refetchInterval: 30_000 })
  const qc = useQueryClient()
  const s = stats.data
  const signIn = () => { window.location.href = `/api/auth/github?return_to=${encodeURIComponent(window.location.pathname)}` }
  const signOut = async () => { await api.logout(); void qc.invalidateQueries({ queryKey: ['stats'] }) }
  const pct = s ? Math.min(100, Math.round((s.tokens_used_today / s.daily_token_cap) * 100)) : 0
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 sm:gap-4 border-b border-line bg-panel px-3 min-w-0">
      <Link to="/" className="flex items-center gap-2 mono text-[11px] uppercase tracking-[.2em] text-ink hover:text-accent">
        <span className="inline-block h-2 w-2 bg-accent" />rewind
      </Link>
      {children}
      {s?.writes === 'warming_up' && <span className="mono text-[10px] uppercase tracking-wider text-k-call" title={s.sandbox_python?.error ?? ''}>sandbox warming up</span>}
      {s?.writes === 'read_only' && <span className="mono text-[10px] uppercase tracking-wider text-muted shrink-0">read-only</span>}
      {s?.sign_in === 'github' && s.writes !== 'read_only' && (
        s.me ? (
          <span className="flex items-center gap-2 shrink-0">
            {s.me.avatar && <img src={s.me.avatar} alt="" className="h-5 w-5 rounded-full" />}
            <span className="mono text-[11px] text-muted hidden sm:inline">{s.me.login}</span>
            <button className="btn" onClick={signOut}>Sign out</button>
          </span>
        ) : (
          <button className="btn btn-accent shrink-0" onClick={signIn}>Sign in with GitHub</button>
        )
      )}
      {s && (
        <span className="mono text-[11px] text-faint hidden sm:flex items-center gap-2 shrink-0" title={`${s.tokens_used_today.toLocaleString()} of ${s.daily_token_cap.toLocaleString()} tokens spent today`}>
          <span className="inline-block h-1.5 w-16 rounded-sm bg-line overflow-hidden">
            <span className="block h-full" style={{ width: `${pct}%`, background: pct > 80 ? 'var(--color-bad)' : 'var(--color-muted)' }} />
          </span>
          <span className="hidden lg:inline">{fmtTokens(s.tokens_used_today)} / {fmtTokens(s.daily_token_cap)} today</span>
        </span>
      )}
    </header>
  )
}
