import type {
  Entry,
  SearchResult,
  Tag,
  AppSettings,
  ApiStatus,
  ImportItem,
  DupeCandidate,
  PaginatedResponse,
} from '../types'

const BASE = '/api'

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(BASE + path, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  })
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText)
    throw new Error(msg || `HTTP ${r.status}`)
  }
  return r.json() as Promise<T>
}

// ── Status ────────────────────────────────────────────────────────────────────

export const getStatus = () => req<ApiStatus>('/status')

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchRequest {
  query: string
  mode: 'semantic' | 'hybrid' | 'literal'
  threshold?: number
  top_k?: number
  alpha?: number
  tags?: string[]
  entry_type?: string
}

export const search = (body: SearchRequest) =>
  req<SearchResult[]>('/search', { method: 'POST', body: JSON.stringify(body) })

export const summarize = (entry_ids: number[], query = '') =>
  req<{ summary: string }>('/search/summarize', {
    method: 'POST',
    body: JSON.stringify({ entry_ids, query }),
  })

// ── Entries ───────────────────────────────────────────────────────────────────

export const listEntries = (params: {
  page?: number
  per_page?: number
  tag?: string
  entry_type?: string
  sort?: string
}) => {
  const q = new URLSearchParams()
  if (params.page) q.set('page', String(params.page))
  if (params.per_page) q.set('per_page', String(params.per_page))
  if (params.tag) q.set('tag', params.tag)
  if (params.entry_type) q.set('entry_type', params.entry_type)
  if (params.sort) q.set('sort', params.sort)
  return req<PaginatedResponse<Entry>>(`/entries?${q}`)
}

export const getEntry = (id: number) => req<Entry>(`/entries/${id}`)

export const createQA = (body: { question: string; answer: string; tags: string[] }) =>
  req<Entry>('/entries', { method: 'POST', body: JSON.stringify(body) })

export const updateQA = (
  id: number,
  body: { question?: string; answer?: string; tags?: string[] },
) => req<Entry>(`/entries/${id}`, { method: 'PUT', body: JSON.stringify(body) })

export const deleteEntry = (id: number) =>
  fetch(BASE + `/entries/${id}`, { method: 'DELETE' })

export const checkDuplicate = (question: string, answer: string) =>
  req<DupeCandidate[]>('/entries/check-duplicate', {
    method: 'POST',
    body: JSON.stringify({ question, answer }),
  })

// ── Tags ──────────────────────────────────────────────────────────────────────

export const listTags = () => req<Tag[]>('/tags')

// ── Import ────────────────────────────────────────────────────────────────────

export const uploadFile = async (file: File): Promise<{ entry_id: number; title: string; chunk_count: number }> => {
  const form = new FormData()
  form.append('file', file)
  const r = await fetch(BASE + '/import', { method: 'POST', body: form })
  if (!r.ok) {
    const msg = await r.text().catch(() => r.statusText)
    throw new Error(msg || `HTTP ${r.status}`)
  }
  return r.json()
}

export const listImports = (page = 1) =>
  req<PaginatedResponse<ImportItem>>(`/import?page=${page}`)

export const getImportStatus = (entry_id: number) =>
  req<{ chunk_count: number; embedded_count: number; done: boolean }>(`/import/${entry_id}/status`)

export const deleteImport = (entry_id: number) =>
  fetch(BASE + `/import/${entry_id}`, { method: 'DELETE' })

// ── Settings ──────────────────────────────────────────────────────────────────

export const getSettings = () => req<AppSettings>('/settings')

export const updateSettings = (body: Partial<AppSettings>) =>
  req<AppSettings>('/settings', { method: 'PUT', body: JSON.stringify(body) })

export const reindex = () =>
  fetch(BASE + '/settings/reindex', { method: 'POST' })

export const resetData = () =>
  req<{ reset: boolean; seed_count: number }>('/settings/reset', { method: 'POST' })
