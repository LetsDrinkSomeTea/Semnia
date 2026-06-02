import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { search, listTags, summarizeStream, listEntries } from '../api/client'
import type { SearchResult, Tag, AppSettings, Entry } from '../types'
import ScoreBar from '../components/ScoreBar'
import EntryTypeBadge from '../components/EntryTypeBadge'
import InfiniteScrollObserver from '../components/InfiniteScrollObserver'
import BrowseEntryItem from '../components/BrowseEntryItem'
import SearchResultItem from '../components/SearchResultItem'
import { extractCitedNums, renderWithCitations } from '../utils/textFormatting'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
  llmReady: boolean
}

type TypeFilter = '' | 'qa' | 'document'
type SortMode = 'updated' | 'calls'

// ── Component ─────────────────────────────────────────────────────────────────

export default function Search({ toast, settings, llmReady }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState(() => sessionStorage.getItem('wdb-q') || '')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(settings.search_threshold)
  const [sort, setSort] = useState<SortMode>('updated')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [tookMs, setTookMs] = useState(0)
  const [browseEntries, setBrowseEntries] = useState<Entry[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)
  const [browsePage, setBrowsePage] = useState(1)
  const [browseHasMore, setBrowseHasMore] = useState(false)
  const [browseLoadingMore, setBrowseLoadingMore] = useState(false)
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
    async (q: string, p = 1) => {
      sessionStorage.setItem('wdb-q', q)
      if (!q.trim()) { setResults([]); setLlmAnswer(null); return }
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      if (p === 1) setLoading(true)
      else setLoadingMore(true)
      const t0 = performance.now()
      try {
        const r = await search({
          query: q,
          threshold,
          top_k: settings.top_k,
          page: p,
          tags: tagFilter ? [tagFilter] : undefined,
          entry_type: typeFilter || undefined,
        })
        setResults((prev) => (p === 1 ? r.items : [...prev, ...r.items]))
        setHasMore(r.has_more)
        if (p === 1) setTookMs(performance.now() - t0)
        setPage(p)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast('Suchfehler', 'error')
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [threshold, tagFilter, typeFilter, settings.top_k, toast],
  )

  useEffect(() => { runSearch(query, 1) }, [query, runSearch])

  const runBrowse = useCallback(
    async (p = 1) => {
      if (p === 1) setBrowseLoading(true)
      else setBrowseLoadingMore(true)
      try {
        const r = await listEntries({
          page: p,
          per_page: 40,
          tag: tagFilter ?? undefined,
          entry_type: typeFilter || undefined,
          sort,
        })
        setBrowseEntries((prev) => (p === 1 ? r.items : [...prev, ...r.items]))
        setBrowseHasMore(r.items.length >= 40)
        setBrowsePage(p)
      } catch {
        toast('Fehler beim Laden', 'error')
      } finally {
        setBrowseLoading(false)
        setBrowseLoadingMore(false)
      }
    },
    [tagFilter, typeFilter, sort, toast]
  )

  useEffect(() => {
    if (!query.trim()) {
      runBrowse(1)
    }
  }, [query, runBrowse])

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
                {llmReady && results.length > 0 && (
                  <button className="btn btn--ghost btn--sm" onClick={askLlm}>
                    {llmBusy ? '✕ Abbrechen' : '✦ KI-Zusammenfassung'}
                  </button>
                )}
                {isSearchMode && llmReady && (
                  <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/agent?q=${encodeURIComponent(query)}`)}>
                    ✦ Nicht zufrieden? KI fragen
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
                      <span className="llm-source-title">{s.display_title}</span>
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
                <BrowseEntryItem
                  key={e.id}
                  entry={e}
                  onClickTag={setTagFilter}
                  formatMeta={formatMeta}
                />
              ))}
              <InfiniteScrollObserver
                hasMore={browseHasMore}
                loading={browseLoadingMore}
                onIntersect={() => runBrowse(browsePage + 1)}
              />
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
              {results.map((r) => (
                <SearchResultItem
                  key={r.id}
                  result={r}
                  onClick={handleResultClick}
                  onClickTag={setTagFilter}
                />
              ))}
              <InfiniteScrollObserver
                hasMore={hasMore}
                loading={loadingMore}
                onIntersect={() => runSearch(query, page + 1)}
              />
            </div>
          ) : null
        )}
      </main>
    </div>
  )
}
