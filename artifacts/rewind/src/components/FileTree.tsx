import { useMemo, useState } from 'react'
import type { FileEntry } from '../api'

interface Node { name: string; path: string; children: Map<string, Node>; file?: FileEntry }

function build(files: FileEntry[]): Node {
  const root: Node = { name: '', path: '', children: new Map() }
  for (const f of files) {
    const parts = f.path.split('/')
    let cur = root
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/')
      if (!cur.children.has(p)) cur.children.set(p, { name: p, path, children: new Map() })
      cur = cur.children.get(p)!
      if (i === parts.length - 1) cur.file = f
    })
  }
  return root
}

function hasChanged(n: Node): boolean {
  if (n.file) return n.file.changed
  for (const c of n.children.values()) if (hasChanged(c)) return true
  return false
}

function Row({ node, depth, selected, onSelect, collapsed, toggle }: {
  node: Node; depth: number; selected: string | null; onSelect: (p: string) => void
  collapsed: Set<string>; toggle: (p: string) => void
}) {
  const isDir = !node.file
  const changed = hasChanged(node)
  const open = !collapsed.has(node.path)
  const kids = [...node.children.values()].sort((a, b) => (Number(!!a.file) - Number(!!b.file)) || a.name.localeCompare(b.name))
  return (
    <>
      <button
        className={`flex w-full items-center gap-1.5 px-2 py-[3px] text-left text-[12px] mono hover:bg-raised ${selected === node.path ? 'bg-accent-dim text-ink' : changed ? 'text-ink' : 'text-muted'}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => (isDir ? toggle(node.path) : onSelect(node.path))}
      >
        <span className="w-3 text-faint shrink-0">{isDir ? (open ? '▾' : '▸') : ''}</span>
        <span className="truncate">{node.name}</span>
        {changed && <span className="ml-auto h-1.5 w-1.5 rounded-full shrink-0" style={{ background: 'var(--color-k-result)' }} title="changed at this step" />}
      </button>
      {isDir && open && kids.map((k) => (
        <Row key={k.path} node={k} depth={depth + 1} selected={selected} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />
      ))}
    </>
  )
}

export default function FileTree({ files, selected, onSelect }: { files: FileEntry[]; selected: string | null; onSelect: (p: string) => void }) {
  const root = useMemo(() => build(files), [files])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (p: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })
  const kids = [...root.children.values()].sort((a, b) => (Number(!!a.file) - Number(!!b.file)) || a.name.localeCompare(b.name))
  if (files.length === 0) return <p className="px-3 py-2 text-[12px] text-muted">No files at this commit.</p>
  return <div className="py-1">{kids.map((k) => <Row key={k.path} node={k} depth={0} selected={selected} onSelect={onSelect} collapsed={collapsed} toggle={toggle} />)}</div>
}
