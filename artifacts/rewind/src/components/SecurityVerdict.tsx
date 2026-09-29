import type { Classification, Runner } from '../api'
import { LEVEL_COLOR, level, reasonLabel } from '../lib/classification'

const EFFECT_TEXT: Record<Classification['effect'], string> = {
  pure: 'reads only, changes nothing',
  reversible_local: 'changes files in the working tree, which Rewind can restore',
  external: 'reaches outside the working tree; Rewind cannot undo it',
  unknown: 'effect could not be determined',
}

function Meter({ label, value, max, color, note }: { label: string; value: number; max: number; color: string; note: string }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="mono text-ink">{value.toFixed(2)}<span className="text-faint"> / {max}</span></span>
      </div>
      <div className="h-[3px] w-full" style={{ background: 'var(--color-line)' }}>
        <div className="h-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <div className="text-[11px] text-faint">{note}</div>
    </div>
  )
}

/**
 * The verdict on a tool result, shown in the step body when there is something to say. Numbers
 * come from the model, reasons from rules and thresholds; the two buttons act on the finding.
 */
export default function SecurityVerdict({ c, runner, onFork }: { c: Classification; runner: Runner | undefined; onFork: (mode: 'investigate' | 'recover' | null) => void }) {
  const l = level(c)
  if (l === 'none') return null
  const color = LEVEL_COLOR[l]
  const bg = l === 'flag' ? 'var(--color-bad-dim)' : l === 'watch' ? 'var(--color-warn-dim)' : 'transparent'
  const title = l === 'flag' ? 'Flagged' : l === 'watch' ? 'External side effect' : 'Classifier error'
  const ruleReasons = c.reasons.filter((r) => !['injection', 'severity', 'classifier_error'].includes(r))
  const modelReasons = c.reasons.filter((r) => r === 'injection' || r === 'severity')
  const oc = runner === 'opencode'
  return (
    <section className="border px-4 py-3 space-y-3" style={{ borderColor: color, background: bg }} aria-label="Security verdict">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[13px] font-medium" style={{ color }}>{title}</span>
        {c.reasons.map((r) => (
          <span key={r} className="mono text-[11px] px-1.5 py-0.5 border" style={{ borderColor: color, color }}>{reasonLabel(r)}</span>
        ))}
        <span className="ml-auto mono text-[11px] text-faint">{c.source === 'inline' ? 'checked inline, before the model saw it' : 'checked after the fact'}</span>
      </div>
      {l !== 'error' && (
        <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
          <Meter label="Injection" value={c.injection} max={1} color={c.injection > 0.5 ? 'var(--color-bad)' : 'var(--color-muted)'}
            note={c.injection > 0.5 ? 'the result reads as instructions to the agent' : 'not read as instructions to the agent'} />
          <Meter label="Severity" value={c.severity} max={4} color={c.severity >= 3 ? 'var(--color-bad)' : c.severity >= 2 ? 'var(--color-warn)' : 'var(--color-muted)'}
            note={c.severity >= 3 ? 'dangerous for the user if acted on' : 'low danger if acted on'} />
          <Meter label="Effect confidence" value={c.effect_conf} max={1} color={c.effect === 'external' ? 'var(--color-warn)' : 'var(--color-muted)'}
            note={`${c.effect.replace('_', ' ')}: ${EFFECT_TEXT[c.effect]}`} />
        </div>
      )}
      <p className="text-[12px] text-muted max-w-[70ch]">
        {ruleReasons.length > 0 && modelReasons.length > 0
          ? 'Both the rules and the model raised this.'
          : ruleReasons.length > 0
            ? 'A deterministic rule raised this; the model is not consulted to clear it.'
            : modelReasons.length > 0
              ? 'No rule matched; the model raised this on its own. The model can raise a flag but never clear one.'
              : l === 'error' ? 'The classifier could not be reached, so only the rules ran on this step.' : 'Below the flag threshold, shown because the effect reaches outside the working tree.'}
      </p>
      {l !== 'error' && (
        <div className="flex flex-wrap items-center gap-2">
          {oc ? (
            <>
              <button type="button" className="btn btn-accent" onClick={() => onFork('investigate')} title="Fork from before this step with the same context; proves what this step caused">Investigate from before this step</button>
              <button type="button" className="btn btn-accent" onClick={() => onFork('recover')} title="Fork from before this step with a ledger of what happened after it">Recover from before this step</button>
            </>
          ) : (
            <button type="button" className="btn btn-accent" onClick={() => onFork(null)}>Fork from before this step</button>
          )}
          <span className="text-[11px] text-faint">Files are restored to the snapshot before this step.</span>
        </div>
      )}
    </section>
  )
}
