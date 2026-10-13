import { useState } from 'react'
import { api } from '../api'
import { useAuth } from '../store'

/** Asks for the access key once per tab. Kept in memory only. */
export default function AccessKeyPrompt({ compact = false }: { compact?: boolean }) {
  const setKey = useAuth((s) => s.setKey)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true); setError(null)
    const res = await api.authCheck(value.trim())
    setBusy(false)
    if (res.ok) setKey(value.trim())
    else setError(res.detail ?? 'That key was not accepted.')
  }
  return (
    <form onSubmit={submit} className={`space-y-2 ${compact ? '' : 'p-3 border border-line rounded bg-panel'}`}>
      <p className="text-[12px] text-muted">Enter the access key to create or fork branches. It stays in this tab only.</p>
      <div className="flex gap-2">
        <input className="field" type="password" placeholder="REWIND_ACCESS_KEY" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        <button className="btn btn-accent shrink-0" disabled={busy || !value.trim()}>Use key</button>
      </div>
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </form>
  )
}
