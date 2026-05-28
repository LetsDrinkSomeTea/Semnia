import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { search, listTags, summarizeStream, listEntries } from '../api/client'
import type { SearchResult, Tag, AppSettings, Entry } from '../types'
import ScoreBar from '../components/ScoreBar'
import EntryTypeBadge from '../components/EntryTypeBadge'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
  ollamaReady: boolean
}

type TypeFilter = '' | 'qa' | 'document'
type SortMode = 'updated' | 'calls'

// ── Citation helpers ───────────────────────────────────────────────────────────

function extractCitedNums(text: string): Set<number> {
  const cited = new Set<number>()
  for (const m of text.matchAll(/\[#?([\d,\s#]+)\]/g))
    m[1].split(/[,\s#]+/).map(Number).filter(Boolean).forEach((n) => cited.add(n))
  return cited
}

// ── Citation rendering ─────────────────────────────────────────────────────────

function renderWithCitations(
  text: string,
  sources: SearchResult[],
  onCite: (id: number) => void,
): React.ReactNode[] {
  const parts = text.split(/(\[#?\d+(?:[,\s#]*#?\d+)*\])/g)
  return parts.map((part, i) => {
    const match = part.match(/^\[#?([\d,\s#]+)\]$/)
    if (!match) return part
    const nums = match[1].split(/[,\s#]+/).map(Number).filter((n) => n >= 1 && n <= sources.length)
    if (!nums.length) return part
    return (
      <span key={i} className="llm-citations">
        {nums.map((n) => {
          const src = sources[n - 1]
          return (
            <button key={n} className="llm-citation" title={src?.title} onClick={() => src && onCite(src.id)}>
              {n}
            </button>
          )
        })}
      </span>
    )
  })
}

// ── Snippet rendering ──────────────────────────────────────────────────────────

function computeSpans(text: string, words: string[]): number[][] {
  const spans: number[][] = []
  const low = text.toLowerCase()
  for (const w of words) {
    let pos = 0
    while (true) {
      const idx = low.indexOf(w, pos)
      if (idx === -1) break
      spans.push([idx, idx + w.length])
      pos = idx + 1
    }
  }
  return spans
}

function renderHighlighted(text: string, spans: number[][]): React.ReactNode {
  if (!spans.length) return text
  const parts: React.ReactNode[] = []
  let cursor = 0
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  for (const [s, e] of sorted) {
    if (s > cursor) parts.push(text.slice(cursor, s))
    parts.push(<mark key={s}>{text.slice(s, e)}</mark>)
    cursor = e
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function renderSnippet(snippet: string, spans: number[][]): React.ReactNode {
  return renderHighlighted(snippet, spans)
}

// ── Field chip ─────────────────────────────────────────────────────────────────

const FIELD_LABELS: Record<string, string> = {
  question: 'Frage',
  answer: 'Antwort',
  title: 'Titel',
  tag: 'Tag',
  content: 'Inhalt',
}

function FieldChip({ chunk_type }: { chunk_type?: string }) {
  if (!chunk_type) return null
  const label = FIELD_LABELS[chunk_type]
  if (!label) return null
  return <span className={`field-chip field-chip--${chunk_type}`}>{label}</span>
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Search({ toast, settings, ollamaReady }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState(() => sessionStorage.getItem('wdb-q') || '')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(settings.search_threshold)
  const [sort, setSort] = useState<SortMode>('updated')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [tookMs, setTookMs] = useState(0)
  const [browseEntries, setBrowseEntries] = useState<Entry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [totalEntries, setTotalEntries] = useState(0)
  const [llmAnswer, setLlmAnswer] = useState<string | null>(null)
  const [llmSources, setLlmSources] = useState<SearchResult[]>([])
  const [llmBusy, setLlmBusy] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => setThreshold(settings.search_threshold), [settings.search_threshold])
  useEffect(() => { listTags().then(({ tags, total }) => { setTags(tags); setTotalEntries(total) }).catch(() => { }) }, [])
  useEffect(() => { inputRef.current?.focus() }, [])

  const runSearch = useCallback(
    async (q: string) => {
      sessionStorage.setItem('wdb-q', q)
      if (!q.trim()) { setResults([]); setLlmAnswer(null); return }
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      setLoading(true)
      const t0 = performance.now()
      try {
        const r = await search({
          query: q,
          threshold,
          top_k: settings.top_k,
          tags: tagFilter ? [tagFilter] : undefined,
          entry_type: typeFilter || undefined,
        })
        setResults(r)
        setTookMs(performance.now() - t0)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast('Suchfehler', 'error')
      } finally {
        setLoading(false)
      }
    },
    [threshold, tagFilter, typeFilter, settings.top_k, toast],
  )

  useEffect(() => { runSearch(query) }, [query, runSearch])

  useEffect(() => {
    if (query.trim()) return
    setBrowseLoading(true)
    listEntries({ per_page: 40, tag: tagFilter ?? undefined, entry_type: typeFilter || undefined, sort })
      .then((r) => setBrowseEntries(r.items))
      .catch(() => toast('Fehler beim Laden', 'error'))
      .finally(() => setBrowseLoading(false))
  }, [query, tagFilter, typeFilter, sort])

  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); runSearch(query) }
  const llmAbortRef = useRef<AbortController | null>(null)

  const formatMeta = (e: Entry): string => {
    if (sort === 'calls') return e.call_count > 0 ? `${e.call_count}×` : '—'
    return e.updated_at ? new Date(e.updated_at).toLocaleDateString('de-DE') : '—'
  }

  const askLlm = () => {
    if (llmBusy) {
      llmAbortRef.current?.abort()
      llmAbortRef.current = null
      setLlmBusy(false)
      return
    }
    if (!results.length) return
    const sources = results.slice(0, 5)
    setLlmAnswer('')
    setLlmSources(sources)
    setLlmBusy(true)
    const ctrl = new AbortController()
    llmAbortRef.current = ctrl
    summarizeStream(
      sources.map((r) => ({ entry_id: r.id, chunk_id: r.matched_chunk_id })),
      query,
      (token) => setLlmAnswer((prev) => (prev ?? '') + token),
      () => { setLlmBusy(false); llmAbortRef.current = null },
      (msg) => { toast(msg, 'error'); setLlmBusy(false); llmAbortRef.current = null },
      ctrl.signal,
    )
  }

  const handleResultClick = (r: SearchResult) => {
    sessionStorage.setItem(`highlight-${r.id}`, JSON.stringify({
      query,
      matched_by: r.matched_by,
      matched_chunk_type: r.matched_chunk_type,
      snippet: r.snippet,
    }))
    navigate(`/entries/${r.id}`)
  }

  const activeFilters = (tagFilter ? 1 : 0) + (typeFilter ? 1 : 0)
  const noResults = query.trim() && !loading && results.length === 0
  const sliderStyle = { '--p': `${threshold * 100}%` } as React.CSSProperties
  const isSearchMode = !!query.trim()

  const sidebar = (
    <>
      <div>
        <h5>Eintragstyp</h5>
        <div className="mode-track">
          {(['', 'qa', 'document'] as TypeFilter[]).map((t) => (
            <button key={t} className={typeFilter === t ? 'on' : ''} onClick={() => { setTypeFilter(t); setFilterOpen(false) }}>
              {t === '' ? 'Alle' : t === 'qa' ? 'Q&A' : 'DOK'}
            </button>
          ))}
        </div>
      </div>

      {isSearchMode && (
        <div>
          <h5>Schwelle</h5>
          <div className="threshold-slider" style={sliderStyle}>
            <div className="track" onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setThreshold(Math.round(((e.clientX - rect.left) / rect.width) * 100) / 100)
            }}>
              <div className="fill" /><div className="knob" />
            </div>
            <div className="label">
              <span>0</span><span className="v">{threshold.toFixed(2)}</span><span>1</span>
            </div>
          </div>
        </div>
      )}

      <div>
        <h5>Tags</h5>
        <div className="tag-list">
          <div className={`tag-row ${tagFilter === null ? 'on' : ''}`} onClick={() => { setTagFilter(null); setFilterOpen(false) }}>
            <span>Alle</span>
            <span className="count">{totalEntries}</span>
          </div>
          {tags.map((t) => (
            <div key={t.name} className={`tag-row ${tagFilter === t.name ? 'on' : ''}`}
              onClick={() => { setTagFilter(tagFilter === t.name ? null : t.name); setFilterOpen(false) }}>
              <span>{t.name}</span>
              <span className="count">{t.count}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  )

  return (
    <div className="pb-body">
      <aside className={`pb-side ${filterOpen ? 'filter-open' : ''}`}>
        <button className="filter-close-btn" onClick={() => setFilterOpen(false)}>
          <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
          Filter schließen
        </button>
        {sidebar}
      </aside>

      {filterOpen && <div className="filter-overlay" onClick={() => setFilterOpen(false)} />}

      <main className="pb-main">
        <form onSubmit={onSubmit}>
          <div className="search-shell">
            <span className="icon">
              <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            <input ref={inputRef} value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Semnia durchsuchen…" autoComplete="off" spellCheck={false} />
            {query && (
              <button type="button" className="clear" onClick={() => { setQuery(''); setResults([]); setLlmAnswer(null) }}>×</button>
            )}
            <button type="submit" className="submit" aria-label="Suchen">
              <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          </div>
        </form>

        <button className={`filter-toggle-btn ${activeFilters ? 'has-filters' : ''}`} onClick={() => setFilterOpen(true)}>
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="11" y1="18" x2="13" y2="18" />
          </svg>
          Filter{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>

        <div className="meta-line">
          {!isSearchMode ? (
            <>
              <span>{browseLoading ? '…' : `${browseEntries.length} Einträge`}</span>
              <div className="sort-tabs">
                <button className={sort === 'updated' ? 'on' : ''} onClick={() => setSort('updated')}>Zuletzt</button>
                <button className={sort === 'calls' ? 'on' : ''} onClick={() => setSort('calls')}>Beliebt</button>
              </div>
            </>
          ) : (
            <>
              <span>
                {loading ? 'Suche…'
                  : `${results.length} Ergebnis${results.length !== 1 ? 'se' : ''} · ${Math.round(tookMs)}ms`}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                {tagFilter && (
                  <span className="filters">
                    <button className="filter-chip" onClick={() => setTagFilter(null)}>
                      {tagFilter} <span className="x">×</span>
                    </button>
                  </span>
                )}
                {ollamaReady && results.length > 0 && (
                  <button className="btn btn--ghost btn--sm" onClick={askLlm}>
                    {llmBusy ? '✕ Abbrechen' : '✦ KI-Zusammenfassung'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {llmAnswer !== null && (
          <div className="llm-card">
            <div className="llm-head">
              <span className="badge">KI-Zusammenfassung</span>
              <button className="x-btn" onClick={() => { llmAbortRef.current?.abort(); setLlmAnswer(null); setLlmBusy(false) }}>×</button>
            </div>
            <p className="answer">
              {renderWithCitations(llmAnswer, llmSources, (id) => navigate(`/entries/${id}`))}
              {llmBusy && <span className="llm-cursor" />}
            </p>
            {!llmBusy && llmSources.length > 0 && (() => {
              const cited = extractCitedNums(llmAnswer ?? '')
              const usedSources = llmSources
                .map((s, i) => ({ s, n: i + 1 }))
                .filter(({ n }) => cited.size === 0 || cited.has(n))
              return usedSources.length > 0 ? (
                <div className="llm-sources">
                  {usedSources.map(({ s, n }) => (
                    <button key={s.id} className="llm-source-item" onClick={() => navigate(`/entries/${s.id}`)}>
                      <span className="llm-source-n">{n}</span>
                      <span className="llm-source-title">{s.title}</span>
                    </button>
                  ))}
                </div>
              ) : null
            })()}
          </div>
        )}

        {!isSearchMode ? (
          browseLoading ? (
            <div className="empty"><p>Lädt…</p></div>
          ) : browseEntries.length === 0 ? (
            <div className="empty">
              <h3>Keine Einträge</h3>
              <p>{tagFilter || typeFilter ? 'Keine Einträge für diesen Filter.' : 'Noch keine Einträge vorhanden.'}</p>
            </div>
          ) : (
            <div className="results">
              {browseEntries.map((e) => (
                <article key={e.id} className="result result--browse" onClick={() => navigate(`/entries/${e.id}`)} role="button">
                  <div>
                    <h3 className="q">{e.title || e.question || e.content || ''}</h3>
                    <div className="meta-row">
                      <div className="meta-system">
                        <EntryTypeBadge type={e.entry_type} />
                      </div>
                      {e.tags.length > 0 && (
                        <div className="meta-tags">
                          {e.tags.map((t) => (
                            <span className="chip" key={t} role="button"
                              onClick={(ev) => { ev.stopPropagation(); setTagFilter(t) }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="right-side"><span>{formatMeta(e)}</span></div>
                </article>
              ))}
            </div>
          )
        ) : (
          noResults ? (
            <div className="empty">
              <h3>Keine Ergebnisse</h3>
              <p>Versuche andere oder allgemeinere Begriffe.</p>
              <button
                className="btn"
                onClick={() => navigate(`/editor/new?title=${encodeURIComponent(query)}`)}
              >
                + Neuen Eintrag erstellen
              </button>
            </div>
          ) : !loading && results.length > 0 ? (
            <div className="results">
              {results.map((r) => {
                const showContext = r.entry_type === 'qa'
                  && r.question
                  && r.matched_chunk_type !== 'question'
                  && r.matched_chunk_type !== 'title'
                return (
                  <article key={r.id} className="result" onClick={() => handleResultClick(r)} role="button">
                    <ScoreBar score={r.score} />
                    <div>
                      <h3 className="q">{r.title}</h3>
                      {showContext && (
                        <p className="result-context">
                          {(r.question!.length > 100 ? r.question!.slice(0, 100) + '…' : r.question)}
                        </p>
                      )}
                      {r.snippet && (
                        <p className="snippet">
                          {renderSnippet(r.snippet, r.highlight_spans)}
                        </p>
                      )}
                      <div className="meta-row">
                        <div className="meta-system">
                          <EntryTypeBadge type={r.entry_type} />
                          <FieldChip chunk_type={r.matched_chunk_type} />
                        </div>
                        {r.tags.length > 0 && (
                          <div className="meta-tags">
                            {r.tags.map((t) => (
                              <span
                                className="chip"
                                key={t}
                                role="button"
                                onClick={(e) => { e.stopPropagation(); setTagFilter(t) }}
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="right-side"><span>{r.call_count}×</span></div>
                  </article>
                )
              })}
            </div>
          ) : null
        )}
      </main>
    </div>
  )
}
