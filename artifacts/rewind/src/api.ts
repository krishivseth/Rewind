import { useAuth } from './store'

export type BranchStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type StepKind = 'user' | 'assistant' | 'tool_call' | 'tool_result'

export interface Branch {
  id: string
  session_id: string
  parent_branch_id: string | null
  fork_step_index: number | null
  model_id: string
  task_prompt: string
  status: BranchStatus
  error: string | null
  stop_reason?: 'completed' | 'call_limit' | 'loop' | 'token_budget' | 'wall_clock' | 'cancelled' | 'provider_error' | 'crash' | null
  step_count: number
  total_input_tokens: number
  total_output_tokens: number
  bundle_key: string | null
  est_cost_usd?: number
  created_at: string
  finished_at: string | null
  queue_position?: number
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface Step {
  id: string
  branch_id: string
  index: number
  kind: StepKind
  content: Record<string, unknown> & { role?: string; content?: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; function?: ToolCall['function'] }
  tool_name: string | null
  tool_args: Record<string, unknown> | null
  tool_result: string | null
  commit_hash: string | null
  files_changed: string[]
  input_tokens: number
  output_tokens: number
  latency_ms: number
  note: string | null
  created_at: string
}

export interface SearchHit {
  session_id: string; session_title: string; repo_slug: string; branch_id: string; model_id: string
  branch_status: BranchStatus; step_index: number; kind: StepKind; tool_name: string | null; snippet: string
}
export interface Stats { tokens_used_today: number; daily_token_cap: number; branches: number; max_concurrent_branches: number; session_token_budget?: number; storage_backend?: 'object' | 'local'; read_only?: boolean; writes?: 'open' | 'warming_up' | 'read_only'; public_writes?: 'cheap' | 'signed_in' | 'off'; sign_in?: 'github' | 'off'; me?: { login: string; avatar: string | null } | null; public_max_model_calls?: number; public_daily_token_cap?: number; cheap_model?: string; sandbox_python?: { ready: boolean; bin: string | null; error: string | null } }

export interface SessionSummary {
  id: string; title: string; repo_slug: string; repo_id: string; root_branch_id: string | null
  model_id: string | null; branch_count: number; created_at: string
  branches: { id: string; parent_branch_id: string | null; fork_step_index: number | null; status: BranchStatus; step_count: number }[]
}
export interface SessionDetail {
  id: string; title: string; repo_slug: string; repo_id: string; root_branch_id: string | null; created_at: string
  branches: Branch[]
}
export interface Repo { id: string; slug: string; name: string; description: string }
export interface Model { id: string; name: string; cheap: boolean }
export interface FileEntry { path: string; changed: boolean }
export interface FilesAtStep { commit: string; files: FileEntry[] }
export interface FileAtStep { path: string; commit: string; content: string; binary: boolean; previous_commit?: string; previous_content?: string | null }
export interface ContextAtStep { step_index: number; requested_index: number; messages: Record<string, unknown>[]; token_count: number; token_count_source: 'reported' | 'estimated' }
export interface DiffResult { a: { branch_id: string; step_index: number; commit: string }; b: { branch_id: string; step_index: number; commit: string }; files: string[]; patch: string }
export interface ForkResponse { requested_step_index: number; fork_step_index: number; snapped: boolean; branches: Branch[] }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function request<T>(url: string, init: RequestInit = {}, withKey = false): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) }
  if (init.body) headers['Content-Type'] = 'application/json'
  if (withKey) {
    const key = useAuth.getState().key
    if (key) headers['X-Rewind-Key'] = key
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let msg = res.statusText
    try { const j = await res.json(); msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail ?? j) } catch { /* keep statusText */ }
    if (res.status === 401 && withKey) useAuth.getState().setKey(null)
    throw new ApiError(res.status, msg)
  }
  return res.json() as Promise<T>
}

export const api = {
  repos: () => request<Repo[]>('/api/repos'),
  models: () => request<Model[]>('/api/models'),
  sessions: () => request<SessionSummary[]>('/api/sessions'),
  session: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),
  branch: (id: string) => request<Branch>(`/api/branches/${id}`),
  steps: (branchId: string) => request<Step[]>(`/api/branches/${branchId}/steps`),
  files: (branchId: string, index: number) => request<FilesAtStep>(`/api/branches/${branchId}/steps/${index}/files`),
  file: (branchId: string, index: number, path: string) =>
    request<FileAtStep>(`/api/branches/${branchId}/steps/${index}/file?path=${encodeURIComponent(path)}&with_previous=true`),
  context: (branchId: string, index: number) => request<ContextAtStep>(`/api/branches/${branchId}/steps/${index}/context`),
  diff: (a: string, b: string) => request<DiffResult>(`/api/diff?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  authCheck: async (key: string): Promise<{ ok: boolean; detail?: string }> => {
    const r = await fetch('/api/auth/check', { headers: { 'X-Rewind-Key': key } })
    if (r.ok) return { ok: true }
    let detail = `${r.status} ${r.statusText}`
    try { detail = (await r.json()).detail ?? detail } catch { /* keep */ }
    return { ok: false, detail }
  },
  createSession: (body: { repo_id: string; title: string; task_prompt: string; model_id: string }) =>
    request<{ id: string; root_branch_id: string; branch: Branch }>('/api/sessions', { method: 'POST', body: JSON.stringify(body) }, true),
  fork: (branchId: string, body: { step_index: number; model_id: string; edited_task_prompt?: string; count: number }) =>
    request<ForkResponse>(`/api/branches/${branchId}/fork`, { method: 'POST', body: JSON.stringify(body) }, true),
  cancel: (branchId: string) => request<unknown>(`/api/branches/${branchId}/cancel`, { method: 'POST' }, true),
  setNote: (branchId: string, index: number, note: string | null) =>
    request<Step>(`/api/branches/${branchId}/steps/${index}/note`, { method: 'PUT', body: JSON.stringify({ note }) }, true),
  deleteSession: (id: string) => request<{ ok: boolean; branches_deleted: number }>(`/api/sessions/${id}`, { method: 'DELETE' }, true),
  search: (q: string) => request<{ q: string; results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
  stats: () => request<Stats>('/api/stats'),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
}

export const TERMINAL: BranchStatus[] = ['done', 'failed', 'cancelled']
export const isLive = (s: BranchStatus) => s === 'running' || s === 'queued'
