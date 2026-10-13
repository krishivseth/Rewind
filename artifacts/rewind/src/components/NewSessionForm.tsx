import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useAuth, useSelection } from '../store'
import AccessKeyPrompt from './AccessKeyPrompt'

export default function NewSessionForm({ onClose }: { onClose: () => void }) {
  const key = useAuth((s) => s.key)
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos })
  const models = useQuery({ queryKey: ['models'], queryFn: api.models })
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats })
  const [repoId, setRepoId] = useState('')
  const [modelId, setModelId] = useState('')
  const [task, setTask] = useState('')
  const [title, setTitle] = useState('')
  const nav = useNavigate()
  const qc = useQueryClient()
  const selectBranch = useSelection((s) => s.selectBranch)
  const [showKey, setShowKey] = useState(false)
  const signedIn = !!stats.data?.me
  const publicMode = !key && (stats.data?.public_writes === 'cheap' || (stats.data?.public_writes === 'signed_in' && signedIn))
  const needsSignIn = !key && stats.data?.public_writes === 'signed_in' && !signedIn
  const signIn = () => { window.location.href = `/api/auth/github?return_to=${encodeURIComponent(window.location.pathname)}` }

  const repo = repos.data?.find((r) => r.id === (repoId || repos.data?.[0]?.id))
  const cheapId = models.data?.find((m) => m.cheap)?.id
  const model = publicMode && cheapId ? cheapId : modelId || cheapId || models.data?.[0]?.id || ''

  const create = useMutation({
    mutationFn: () => api.createSession({
      repo_id: repo!.id, model_id: model, task_prompt: task.trim(),
      title: title.trim() || `${repo!.slug}: ${task.trim().slice(0, 60)}`,
    }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['sessions'] })
      selectBranch(res.root_branch_id)
      nav(`/sessions/${res.id}`)
    },
  })

  return (
    <div className="border border-line rounded bg-panel">
      <div className="pane-title"><span className="text-ink">New session</span><button className="btn ml-auto" onClick={onClose}>Close</button></div>
      <div className="p-3">
        {needsSignIn && !showKey ? (
          <div className="space-y-2">
            <p className="text-[12px] text-muted">Sign in with GitHub to run {models.data?.find((m) => m.cheap)?.name ?? 'the cheap model'} here, within a shared daily budget. Nothing is stored beyond your login name.</p>
            <div className="flex items-center gap-3">
              <button type="button" className="btn btn-accent" onClick={signIn}>Sign in with GitHub</button>
              <button type="button" className="text-[11px] text-muted hover:text-ink" onClick={() => setShowKey(true)}>Have the access key?</button>
            </div>
          </div>
        ) : !key && (!publicMode || showKey) ? (
          <div className="space-y-2">
            <AccessKeyPrompt compact />
            {(publicMode || needsSignIn) && <button type="button" className="text-[11px] text-muted hover:text-ink" onClick={() => setShowKey(false)}>{needsSignIn ? 'Back' : 'Continue without a key'}</button>}
          </div>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); if (repo && task.trim()) create.mutate() }}>
            {publicMode && (
              <p className="text-[12px] text-muted">
                Visitors can run {models.data?.find((m) => m.id === cheapId)?.name ?? 'the cheap model'} without a key, within a daily budget.{' '}
                <button type="button" className="text-accent hover:underline" onClick={() => setShowKey(true)}>Have the access key?</button>
              </p>
            )}
            <div className="grid gap-3 md:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Repository</span>
                <select className="field mono" value={repo?.id ?? ''} onChange={(e) => setRepoId(e.target.value)}>
                  {repos.data?.map((r) => <option key={r.id} value={r.id}>{r.slug}</option>)}
                </select>
                {repo && <p className="text-[11px] text-faint">{repo.description}</p>}
              </label>
              <label className="block space-y-1">
                <span className="text-[11px] text-muted">Model</span>
                <select className="field mono" value={model} disabled={publicMode} onChange={(e) => setModelId(e.target.value)}>
                  {models.data?.map((m) => <option key={m.id} value={m.id}>{m.name}{m.cheap ? ' (cheap)' : ''}</option>)}
                </select>
              </label>
            </div>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Task for the agent</span>
              <textarea className="field min-h-[80px] resize-y" placeholder="Make all tests pass" value={task} onChange={(e) => setTask(e.target.value)} autoFocus />
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted">Title <span className="text-faint">optional</span></span>
              <input className="field" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={repo && task ? `${repo.slug}: ${task.slice(0, 60)}` : ''} />
            </label>
            {stats.data?.writes === 'warming_up' && <p className="text-[12px] text-k-call">The sandbox is still warming up after a restart. Try again in about a minute.</p>}
            {stats.data?.writes === 'read_only' && <p className="text-[12px] text-muted">This deployment is read-only.</p>}
            {create.error && <p className="text-[12px] text-bad">{(create.error as Error).message}</p>}
            <div className="flex items-center gap-3">
              <button className="btn btn-accent" disabled={create.isPending || !repo || !task.trim() || (stats.data?.writes !== undefined && stats.data.writes !== 'open')}>{create.isPending ? 'Starting…' : 'Start session'}</button>
              <span className="text-[11px] text-faint">Runs up to 30 model calls, then stops. Fork it from any step afterwards.</span>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
