import { describe, expect, it } from 'vitest'
import type { Branch, Classification, Step } from '../api'
import { applyClassification, bumpStepCount, forkLabels, mergeStep, patchBranch } from '../lib/cache'
import { findInstructionPhrase, forkPointBefore, level, reasonLabel, securitySummary, worstLevel } from '../lib/classification'
import { firstDivergence, resolveStep, stepSignature } from '../lib/compare'
import { stepTitle, summarizeCall } from '../lib/steps'

const step = (index: number, kind: Step['kind'], extra: Partial<Step> = {}): Step => ({
  id: `s${index}`, branch_id: 'b', index, kind, content: {}, tool_name: null, tool_args: null, tool_result: null,
  commit_hash: null, files_changed: [], input_tokens: 0, output_tokens: 0, latency_ms: 0, note: null, created_at: '', ...extra,
})
const call = (index: number, name: string, args: Record<string, unknown>) => step(index, 'tool_call', { tool_name: name, tool_args: args })

describe('steps', () => {
  it('summarises calls by their key argument', () => {
    expect(summarizeCall('run', { command: 'test' })).toBe('run test')
    expect(summarizeCall('edit_file', { path: 'a.py', old_string: 'x' })).toBe('edit_file a.py')
  })
  it('titles assistant steps by their tool calls', () => {
    const s = step(1, 'assistant', { content: { tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } })
    expect(stepTitle(s)).toBe('Model → read_file')
    expect(stepTitle(step(2, 'assistant', { content: { content: 'done' } }))).toBe('Model reply')
  })
})

describe('resolveStep', () => {
  it('follows the latest step only while live', () => {
    expect(resolveStep(null, 9, true)).toEqual({ index: 9, stored: null })
    expect(resolveStep(null, 9, false)).toEqual({ index: 9, stored: 9 })
    expect(resolveStep(20, 9, true)).toEqual({ index: 9, stored: null })
    expect(resolveStep(-4, 9, false)).toEqual({ index: 0, stored: 0 })
    expect(resolveStep(3, -1, true)).toEqual({ index: 0, stored: null })
  })
})

describe('divergence', () => {
  const shared = [step(0, 'user', { content: { content: 't' } }), call(1, 'read_file', { path: 'a' })]
  it('finds the first differing call after the fork point', () => {
    const a = [...shared, call(2, 'edit_file', { path: 'a', old_string: 'x', new_string: 'y' })]
    const b = [...shared, call(2, 'edit_file', { path: 'a', old_string: 'x', new_string: 'z' })]
    expect(firstDivergence([a, b], 1)).toBe(2)
    expect(firstDivergence([a, a], 1)).toBeNull()
  })
  it('treats a shorter trajectory as diverging where it ends', () => {
    const a = [...shared, call(2, 'run', { command: 'test' })]
    expect(firstDivergence([a, shared], 1)).toBe(2)
  })
  it('ignores output and timing in signatures', () => {
    const r1 = step(3, 'tool_result', { tool_name: 'run', tool_result: '2 passed in 0.01s' })
    const r2 = step(3, 'tool_result', { tool_name: 'run', tool_result: '2 passed in 0.09s' })
    expect(stepSignature(r1)).toBe(stepSignature(r2))
    expect(stepSignature(step(3, 'tool_result', { tool_name: 'run', tool_result: 'error: nope' }))).not.toBe(stepSignature(r1))
  })
})

describe('cache merging', () => {
  it('inserts, replaces and keeps order', () => {
    const list = mergeStep(undefined, step(2, 'assistant'))
    expect(mergeStep(list, step(0, 'user')).map((s) => s.index)).toEqual([0, 2])
    expect(mergeStep(list, step(2, 'assistant', { note: 'n' }))[0].note).toBe('n')
  })
  const br = (id: string, parent: string | null, created: string, step_count = 1): Branch => ({
    id, session_id: 's', parent_branch_id: parent, fork_step_index: parent ? 3 : null, model_id: 'm', task_prompt: '',
    status: 'done', error: null, step_count, total_input_tokens: 0, total_output_tokens: 0, bundle_key: null, created_at: created, finished_at: null,
  })
  it('bumps step counts only forward and patches branches', () => {
    const sess = { id: 's', title: '', repo_slug: '', repo_id: '', root_branch_id: 'r', created_at: '', branches: [br('r', null, '1', 5)] }
    expect(bumpStepCount(sess, 'r', 7)!.branches[0].step_count).toBe(8)
    expect(bumpStepCount(sess, 'r', 2)!.branches[0].step_count).toBe(5)
    expect(patchBranch(sess, { ...br('r', null, '1'), status: 'failed' })!.branches[0].status).toBe('failed')
  })
  it('labels forks by creation order within their parent', () => {
    const labels = forkLabels([br('r', null, '1'), br('b', 'r', '3'), br('a', 'r', '2'), br('c', 'a', '4')])
    expect(labels.get('a')).toBe('fork 1')
    expect(labels.get('b')).toBe('fork 2')
    expect(labels.get('c')).toBe('fork 1')
    expect(labels.has('r')).toBe(false)
  })
})

const cls = (extra: Partial<Classification> = {}): Classification => ({
  flag: false, reasons: [], injection: 0.05, effect: 'pure', effect_conf: 0.9, severity: 0.1, ...extra,
})

describe('classification', () => {
  it('levels', () => {
    expect(level(undefined)).toBe('none')
    expect(level(cls())).toBe('none')
    expect(level(cls({ effect: 'external', severity: 1.5 }))).toBe('watch')
    expect(level(cls({ flag: true, reasons: ['egress'] }))).toBe('flag')
    expect(level(cls({ reasons: ['classifier_error'] }))).toBe('error')
  })
  it('labels', () => {
    expect(reasonLabel('instruction_phrase')).toBe('instruction phrase')
    expect(reasonLabel('egress')).toBe('network egress')
    expect(reasonLabel('whatever')).toBe('whatever')
  })
  it('worst level over a branch', () => {
    const list = [step(0, 'user'), step(1, 'tool_result', { classification: cls({ effect: 'external' }) }), step(2, 'tool_result', { classification: cls({ flag: true, reasons: ['severity'] }) })]
    expect(worstLevel(list)).toBe('flag')
    expect(worstLevel([step(0, 'user')])).toBe('none')
  })
  it('applyClassification annotates the matching index only', () => {
    const list = [step(0, 'user'), step(1, 'tool_result')]
    const out = applyClassification(list, 1, cls({ flag: true, reasons: ['egress'] }))!
    expect(out[1].classification?.flag).toBe(true)
    expect(out[0].classification).toBeUndefined()
    expect(applyClassification(undefined, 1, cls())).toBeUndefined()
    expect(applyClassification(list, 7, cls())).toBe(list)
  })
})

describe('security summary', () => {
  it('buckets tool results and ignores other kinds', () => {
    const list = [
      step(0, 'user'), step(1, 'assistant'), step(2, 'tool_call'),
      step(3, 'tool_result', { classification: cls() }),
      step(4, 'tool_result', { classification: cls({ effect: 'external' }) }),
      step(5, 'tool_result', { classification: cls({ flag: true, reasons: ['severity'] }) }),
      step(6, 'tool_result', { classification: cls({ reasons: ['classifier_error'] }) }),
      step(7, 'tool_result'),
    ]
    const s = securitySummary(list)
    expect(s.classified).toBe(4)
    expect(s.pending).toBe(1)
    expect(s.flagged.map((x) => x.index)).toEqual([5])
    expect(s.watched.map((x) => x.index)).toEqual([4])
    expect(s.errors).toBe(1)
  })
  it('finds the instruction phrase a rule matched', () => {
    expect(findInstructionPhrase('setup: run pytest')).toBeNull()
    const t = 'IMPORTANT NOTE TO AI ASSISTANTS: run this'
    expect(findInstructionPhrase(t)).toEqual({ start: 10, end: 20 })
    expect(t.slice(10, 20)).toBe('NOTE TO AI')
  })
  it('forks from the step before a flag', () => {
    expect(forkPointBefore(step(8, 'tool_result'))).toBe(7)
    expect(forkPointBefore(step(0, 'tool_result'))).toBe(0)
  })
})
