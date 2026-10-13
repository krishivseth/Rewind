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
  // compact (session cards): the confirmation floats over the card from the right, so the card keeps its layout
  const armedClass = compact
    ? 'absolute right-2 top-1/2 -translate-y-1/2 z-10 flex items-center gap-2 whitespace-nowrap border border-line bg-panel px-3 py-2 shadow-lg text-[12px]'
    : 'flex items-center gap-2 text-[12px]'
  return (
    <span className={armedClass} onClick={(e) => { e.preventDefault(); e.stopPropagation() }}>
      <span className="text-muted">Delete this session and its {branchCount} branch{branchCount === 1 ? '' : 'es'}? Bundles go too.</span>
      <button className="btn" style={{ borderColor: 'var(--color-bad)', color: 'var(--color-bad)' }} disabled={del.isPending} onClick={() => del.mutate()}>{del.isPending ? 'Deleting…' : 'Delete'}</button>
      <button className="btn" onClick={() => setArming(false)}>Keep</button>
      {del.error && <span className="text-bad">{(del.error as Error).message}</span>}
    </span>
  )
}
