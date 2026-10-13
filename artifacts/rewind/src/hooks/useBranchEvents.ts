import { useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { TERMINAL, isLive, type Branch, type SessionDetail, type Step } from '../api'
import { bumpStepCount, mergeStep, patchBranch } from '../lib/cache'

/**
 * Subscribe to the SSE stream of every live branch in the session and feed the
 * react-query caches, so the tree, the scrubber and the step card update in place.
 */
export function useSessionEvents(sessionId: string | undefined, branches: Branch[]) {
  const qc = useQueryClient()
  const liveIds = branches.filter((b) => isLive(b.status)).map((b) => b.id).sort().join(',')

  useEffect(() => {
    if (!sessionId || !liveIds) return
    const sources = liveIds.split(',').map((branchId) => {
      const es = new EventSource(`/api/branches/${branchId}/events`)
      es.addEventListener('step', (e) => {
        const step: Step = JSON.parse((e as MessageEvent).data).data
        qc.setQueryData<Step[]>(['steps', branchId], (old) => mergeStep(old, step))
        qc.setQueryData<SessionDetail>(['session', sessionId], (old) => bumpStepCount(old, branchId, step.index))
      })
      es.addEventListener('status', (e) => {
        const b: Branch = JSON.parse((e as MessageEvent).data).data
        qc.setQueryData<SessionDetail>(['session', sessionId], (old) => patchBranch(old, b))
        if (TERMINAL.includes(b.status)) {
          es.close()
          void qc.invalidateQueries({ queryKey: ['steps', branchId] })
          void qc.invalidateQueries({ queryKey: ['session', sessionId] })
        }
      })
      return es
    })
    return () => sources.forEach((es) => es.close())
  }, [sessionId, liveIds, qc])
}
