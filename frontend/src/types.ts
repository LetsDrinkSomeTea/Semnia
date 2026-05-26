export interface Entry {
  id: number
  entry_type: 'qa' | 'document'
  title: string
  question: string | null
  answer: string | null
  content: string | null
  source_filename: string | null
  tags: string[]
  created_at: string | null
  updated_at: string | null
  call_count: number
  related?: RelatedEntry[]
}

export interface RelatedEntry {
  id: number
  entry_type: 'qa' | 'document'
  title: string
  tags: string[]
}

export interface SearchResult {
  id: number
  entry_type: 'qa' | 'document'
  title: string
  snippet: string
  highlight_spans: number[][]
  score: number
  tags: string[]
  call_count: number
}

export interface Tag {
  name: string
  count: number
}

export interface AppSettings {
  search_threshold: number
  dupe_threshold: number
  top_k: number
  hybrid_alpha: number
  branding_accent: string
  branding_font: string
  branding_logo_b64: string
  ollama_url: string
  ollama_model: string
}

export interface ApiStatus {
  entry_count: number
  model: string
  model_ready: boolean
  ollama_ready: boolean
}

export interface ImportItem {
  id: number
  title: string
  source_filename: string
  tags: string[]
  created_at: string | null
  chunk_count: number
  embedded_count: number
}

export interface DupeCandidate {
  id: number
  title: string
  question: string | null
  score: number
}

export interface PaginatedResponse<T> {
  total: number
  page: number
  per_page: number
  items: T[]
}
