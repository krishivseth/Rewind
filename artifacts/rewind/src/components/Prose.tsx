import type { ReactNode } from 'react'

/** Minimal rendering of the markdown models tend to emit: paragraphs, lists, `code`, **bold**, fences. */
export default function Prose({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/)
  return (
    <div className="space-y-2.5 text-[13px] leading-relaxed max-w-[72ch]">
      {blocks.map((block, i) => renderBlock(block, i))}
    </div>
  )
}

function renderBlock(block: string, key: number): ReactNode {
  const fence = block.match(/^```(\w*)\n([\s\S]*?)\n?```$/)
  if (fence) return <pre key={key} className="mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words rounded border border-line bg-bg p-3">{fence[2]}</pre>
  const lines = block.split('\n')
  if (lines.every((l) => /^\s*(?:[-*]|\d+[.)])\s+/.test(l))) {
    const ordered = /^\s*\d+/.test(lines[0])
    const items = lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, ''))}</li>)
    return ordered
      ? <ol key={key} className="list-decimal pl-5 space-y-1">{items}</ol>
      : <ul key={key} className="list-disc pl-5 space-y-1">{items}</ul>
  }
  const heading = block.match(/^#{1,4}\s+(.*)$/)
  if (heading && lines.length === 1) return <p key={key} className="font-medium text-ink">{inline(heading[1])}</p>
  return <p key={key} className="whitespace-pre-wrap">{inline(block)}</p>
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)/g
  let last = 0, m: RegExpExecArray | null, k = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    if (m[1]) out.push(<code key={k++} className="mono text-[12px] rounded bg-raised px-1 py-px text-ink">{m[1].slice(1, -1)}</code>)
    else out.push(<strong key={k++} className="font-medium text-ink">{inline(m[2].slice(2, -2))}</strong>)
    last = m.index + m[0].length
  }
  if (last < s.length) out.push(s.slice(last))
  return out
}
