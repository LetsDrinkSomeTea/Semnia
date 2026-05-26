import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { search, listTags, summarize } from '../api/client'
import type { SearchResult, Tag, AppSettings } from '../types'
import ScoreBar from '../components/ScoreBar'
import EntryTypeBadge from '../components/EntryTypeBadge'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
  ollamaReady: boolean
}

type Mode = 'semantic' | 'hybrid' | 'literal'
type TypeFilter = '' | 'qa' | 'document'

function renderSnippet(snippet: string, spans: number[][]): React.ReactNode {
  if (!spans.length) return snippet
  const parts: React.ReactNode[] = []
  let cursor = 0
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  for (const [s, e] of sorted) {
    if (s > cursor) parts.push(snippet.slice(cursor, s))
    parts.push(<mark key={s}>{snippet.slice(s, e)}</mark>)
    cursor = e
  }
  if (cursor < snippet.length) parts.push(snippet.slice(cursor))
  return <>{parts}</>
}

export default function Search({ toast, settings, ollamaReady }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState(() => sessionStorage.getItem('wdb-q') || '')
  const [mode, setMode] = useState<Mode>('hybrid')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(settings.search_threshold)
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [tookMs, setTookMs] = useState(0)
  const [tags, setTags] = useState<Tag[]>([])
  const [llmAnswer, setLlmAnswer] = useState<string | null>(null)
  const [llmBusy, setLlmBusy] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => setThreshold(settings.search_threshold), [settings.search_threshold])
  useEffect(() => { listTags().then(setTags).catch(() => {}) }, [])
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
          mode,
          threshold,
          top_k: settings.top_k,
          alpha: settings.hybrid_alpha,
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
    [mode, threshold, tagFilter, typeFilter, settings.top_k, settings.hybrid_alpha, toast],
  )

  useEffect(() => { runSearch(query) }, [query, runSearch])

  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); runSearch(query) }

  const askLlm = async () => {
    if (!results.length) return
    setLlmBusy(true)
    setLlmAnswer(null)
    try {
      const r = await summarize(results.slice(0, 5).map((r) => r.id), query)
      setLlmAnswer(r.summary)
    } catch {
      toast('KI-Zusammenfassung nicht verfügbar', 'error')
    } finally {
      setLlmBusy(false)
    }
  }

  const activeFilters = (tagFilter ? 1 : 0) + (typeFilter ? 1 : 0)
  const sliderStyle = { '--p': `${threshold * 100}%` } as React.CSSProperties

  const sidebar = (
    <>
      <div>
        <h5>Typ</h5>
        <div className="mode-track">
          {(['', 'qa', 'document'] as TypeFilter[]).map((t) => (
            <button
              key={t}
              className={typeFilter === t ? 'on' : ''}
              onClick={() => { setTypeFilter(t); setFilterOpen(false) }}
            >
              {t === '' ? 'Alle' : t === 'qa' ? 'Q&A' : 'DOK'}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h5>Schwelle</h5>
        <div className="threshold-slider" style={sliderStyle}>
          <div
            className="track"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setThreshold(Math.round(((e.clientX - rect.left) / rect.width) * 100) / 100)
            }}
          >
            <div className="fill" />
            <div className="knob" />
          </div>
          <div className="label">
            <span>0</span>
            <span className="v">{threshold.toFixed(2)}</span>
            <span>1</span>
          </div>
        </div>
      </div>

      <div>
        <h5>Tags</h5>
        <div className="tag-list">
          <div
            className={`tag-row ${tagFilter === null ? 'on' : ''}`}
            onClick={() => { setTagFilter(null); setFilterOpen(false) }}
          >
            <span>Alle</span>
            <span className="count">{tags.reduce((s, t) => s + t.count, 0)}</span>
          </div>
          {tags.map((t) => (
            <div
              key={t.name}
              className={`tag-row ${tagFilter === t.name ? 'on' : ''}`}
              onClick={() => { setTagFilter(tagFilter === t.name ? null : t.name); setFilterOpen(false) }}
            >
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
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Wissensdatenbank durchsuchen…"
              autoComplete="off"
              spellCheck={false}
            />
            {query && (
              <button type="button" className="clear" onClick={() => { setQuery(''); setResults([]); setLlmAnswer(null) }}>
                ×
              </button>
            )}
            <div className="modes">
              {(['hybrid', 'semantic', 'literal'] as Mode[]).map((m) => (
                <button key={m} type="button" className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
                  {m === 'hybrid' ? 'Hybrid' : m === 'semantic' ? 'Semantik' : 'Literal'}
                </button>
              ))}
            </div>
            <button type="submit" className="submit">Suchen</button>
          </div>
        </form>

        {/* Mobile filter button */}
        <button
          className={`filter-toggle-btn ${activeFilters ? 'has-filters' : ''}`}
          onClick={() => setFilterOpen(true)}
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <line x1="4" y1="6" x2="20" y2="6" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="11" y1="18" x2="13" y2="18" />
          </svg>
          Filter{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>

        {/* Status line */}
        {query.trim() && (
          <div className="meta-line">
            <span>
              {loading
                ? 'Suche…'
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
                <button className="btn btn--ghost btn--sm" onClick={askLlm} disabled={llmBusy}>
                  {llmBusy ? 'KI…' : '✦ KI-Zusammenfassung'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* LLM answer */}
        {llmAnswer && (
          <div className="llm-card">
            <div className="llm-head">
              <span className="badge">KI-Zusammenfassung</span>
              <button className="x-btn" onClick={() => setLlmAnswer(null)}>×</button>
            </div>
            <p className="answer">{llmAnswer}</p>
          </div>
        )}

        {/* Results */}
        {query.trim() ? (
          results.length > 0 ? (
            <div className="results">
              {results.map((r) => (
                <article
                  key={r.id}
                  className="result"
                  onClick={() => navigate(`/entries/${r.id}`)}
                  role="button"
                >
                  <ScoreBar score={r.score} />
                  <div>
                    <h3 className="q">{r.title}</h3>
                    <p className="snippet">{renderSnippet(r.snippet, r.highlight_spans)}</p>
                    <div className="meta-row">
                      <EntryTypeBadge type={r.entry_type} />
                      {r.tags.map((t) => (
                        <span className="chip" key={t}>{t}</span>
                      ))}
                    </div>
                  </div>
                  <div className="right-side">
                    <span>{r.call_count}×</span>
                  </div>
                </article>
              ))}
            </div>
          ) : !loading ? (
            <div className="empty">
              <h3>Keine Ergebnisse</h3>
              <p>Probiere einen anderen Suchbegriff oder senke die Ähnlichkeitsschwelle.</p>
            </div>
          ) : null
        ) : (
          <div className="empty-search">
            <div className="empty-search-head">
              <h2>Was möchtest du wissen?</h2>
              <p>
                Suche mit <em>natürlicher Sprache</em> — semantische Suche versteht den Sinn,
                nicht nur die exakten Wörter.
              </p>
            </div>
            {tags.length > 0 && (
              <>
                <p className="section-h">Themen</p>
                <div className="suggest-grid">
                  {tags.slice(0, 8).map((t) => (
                    <button
                      key={t.name}
                      className="suggest"
                      onClick={() => { setTagFilter(t.name); setQuery(t.name) }}
                    >
                      <svg width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                        <line x1="7" y1="7" x2="7.01" y2="7" />
                      </svg>
                      {t.name} ({t.count})
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
