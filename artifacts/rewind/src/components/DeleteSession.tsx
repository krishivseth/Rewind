import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth } from '../store'

/** Two-step delete without a browser dialog. Only renders once a key is entered. */
export default function DeleteSession({ sessionId, branchCount, compact = false, onDone }: { sessionId: string; branchCount: number; compact?: boolean; onDone?: () => void }) {
  const key = useAuth((s) => s.key)
  const [arming, setArming] = useState(false)
  const qc = useQueryClient()
  const nav = useNavigate()
  const del = useMutation({
    mutationFn: () => api.deleteSession(sessionId),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['sessions'] }); onDone ? onDone() : nav('/') },
  })
  if (!key) return null
  if (!arming) return <button className={`btn ${compact ? 'text-[11px] py-0.5' : ''}`} onClick={(e) => { e.preventDefault(); e.stopPropagation(); setArming(true) }}>Delete</button>
  return (
    <span className="flex items-center gap-2 text-[12px]" onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <span className="text-muted">Delete this session and its {branchCount} branch{branchCount === 1 ? '' : 'es'}? Bundles go too.</span>
      <button className="btn" style={{ borderColor: 'var(--color-bad)', color: 'var(--color-bad)' }} disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete'}</button>
      <button className="btn" onClick={() => setArming(false)}>Keep</button>
      {del.error && <span className="text-bad">{(del.error as Error).message}</span>}
    </span>
  )
}
