import { useMemo } from 'react'
import type { Branch } from '../api'
import { forkLabels } from '../lib/cache'
import { fmtCost, shortModel } from '../lib/steps'
import StatusBadge from './StatusBadge'

interface Props {
  branches: Branch[]
  selected: string | null
  diffOther: string | null
  onSelect: (id: string) => void
  onShiftSelect: (id: string) => void
  onCompare: (parentId: string) => void
  comparing: string | null
}

/** Root at the top; forks hang off their parent, labelled with the step they left from. */
export default function BranchTree({ branches, selected, diffOther, onSelect, onShiftSelect, onCompare, comparing }: Props) {
  const labels = useMemo(() => forkLabels(branches), [branches])
  const { roots, children } = useMemo(() => {
    const children = new Map<string, Branch[]>()
    const ids = new Set(branches.map((b) => b.id))
    const roots: Branch[] = []
    for (const b of branches) {
      if (b.parent_branch_id && ids.has(b.parent_branch_id)) {
        const arr = children.get(b.parent_branch_id) ?? []
        arr.push(b)
        children.set(b.parent_branch_id, arr)
      } else roots.push(b)
    }
    const order = (a: Branch, b: Branch) => (a.fork_step_index ?? -1) - (b.fork_step_index ?? -1) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
    for (const arr of children.values()) arr.sort(order)
    roots.sort(order)
    return { roots, children }
  }, [branches])

  const render = (b: Branch, depth: number, last: boolean): React.ReactNode => {
    const kids = children.get(b.id) ?? []
    void last
    const isSel = b.id === selected
    const isOther = b.id === diffOther
    return (
      <li key={b.id} className="relative">
        {depth > 0 && <span className="absolute left-[-13px] top-[17px] h-px w-[10px] bg-line" aria-hidden />}
        <button
          className={`group flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left border ${
            isSel ? 'border-accent bg-accent-dim' : isOther ? 'border-k-call bg-raised' : 'border-transparent hover:bg-raised'
          }`}
          onClick={(e) => (e.shiftKey ? onShiftSelect(b.id) : onSelect(b.id))}
          title={`${b.model_id}\n${b.task_prompt.slice(0, 200)}${e(b)}`}
        >
          <span className="flex items-center gap-2 w-full">
            <StatusBadge branch={b} compact />
            {labels.get(b.id) ? (
              <><span className="mono text-[12px] text-ink shrink-0">{labels.get(b.id)}</span><span className="mono text-[11px] text-muted truncate">{shortModel(b.model_id)}</span></>
            ) : (
              <span className="mono text-[12px] text-ink truncate">{shortModel(b.model_id)}</span>
            )}
            <span className="ml-auto flex items-center gap-2 shrink-0">
              {b.est_cost_usd !== undefined && b.est_cost_usd > 0 && <span className="mono text-[10px] text-faint">{fmtCost(b.est_cost_usd)}</span>}
              {isOther && <span className="text-[10px] mono" style={{ color: 'var(--color-k-call)' }}>B</span>}
              {isSel && <span className="text-[10px] mono text-accent">A</span>}
            </span>
          </span>
          <span className="flex items-center gap-2 text-[11px] text-muted w-full whitespace-nowrap">
            <StatusBadge branch={b} />
            <span className="mono">{b.step_count} steps</span>
            {b.fork_step_index !== null && <span className="mono text-faint">at {b.fork_step_index}</span>}
          </span>
        </button>
        {kids.length > 1 && (
          <button
            className={`ml-2 mt-0.5 text-[11px] hover:text-ink ${comparing === b.id ? 'text-accent' : 'text-muted'}`}
            onClick={() => onCompare(b.id)}
            title="Line up every fork of this branch and find where they diverge"
          >
            {comparing === b.id ? 'comparing' : `compare ${kids.length} forks`}
          </button>
        )}
        {kids.length > 0 && (
          <ul className="ml-[9px] mt-0.5 space-y-0.5 pl-[13px] border-l border-line">
            {kids.map((k, i) => render(k, depth + 1, i === kids.length - 1))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <div className="p-2">
      <ul className="space-y-0.5">{roots.map((r, i) => render(r, 0, i === roots.length - 1))}</ul>
      <p className="mt-3 px-1 text-[11px] text-faint">Click to select. Shift-click a second branch to diff.</p>
    </div>
  )
}

function e(b: Branch) { return b.error ? `\n\n${b.status}: ${b.error}` : '' }
