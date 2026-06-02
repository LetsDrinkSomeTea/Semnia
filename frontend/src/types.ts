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
  question?: string | null
  tags: string[]
}

export interface SearchResult {
  id: number
  entry_type: 'qa' | 'document'
  title: string
  question?: string | null
  snippet: string
  highlight_spans: number[][]
  score: number
  tags: string[]
  call_count: number
  matched_by?: 'semantic' | 'bm25' | 'fuzzy'
  matched_chunk_type?: 'question' | 'answer' | 'content' | 'title' | 'tag'
  matched_chunk_id?: number | null
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
  chunk_size: number
  chunk_overlap: number
  branding_name: string
  branding_accent: string
  branding_font: string
  branding_logo_b64: string
  branding_custom_css: string
  llm_url: string
  llm_model: string
  llm_api_key: string
}

export interface ApiStatus {
  entry_count: number
  chunk_count: number
  unembedded_chunks: number
  reindexing: boolean
  db_size_bytes: number
  model: string
  model_ready: boolean
  llm_status: 'inactive' | 'error' | 'ready'
  llm_model: string
  meilisearch_stats?: {
    number_of_documents: number
    is_indexing: boolean
  } | null
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
