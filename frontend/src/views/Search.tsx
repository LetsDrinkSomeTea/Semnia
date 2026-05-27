import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { search, fuzzySearch, listTags, summarizeStream } from '../api/client'
import type { SearchResult, Tag, AppSettings } from '../types'
import ScoreBar from '../components/ScoreBar'
import EntryTypeBadge from '../components/EntryTypeBadge'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
  ollamaReady: boolean
}

type TypeFilter = '' | 'qa' | 'document'
type MethodFilter = '' | 'semantic' | 'bm25'

// ── Citation rendering ─────────────────────────────────────────────────────────

function renderWithCitations(
  text: string,
  sources: SearchResult[],
  onCite: (id: number) => void,
): React.ReactNode[] {
  // Match [1], [#1], [1,2], [#1,#2] — models aren't always consistent
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

/** Highlight query words in title — only for non-semantic matches */
function renderTitle(title: string, query: string, matchedBy?: string): React.ReactNode {
  if (!matchedBy || matchedBy === 'semantic') return title
  const words = query.split(/\s+/).filter(w => w.length > 2).map(w => w.toLowerCase())
  const spans = computeSpans(title, words)
  return renderHighlighted(title, spans)
}

// ── Match badge ────────────────────────────────────────────────────────────────

const MATCH_LABELS: Record<string, string> = {
  semantic: 'Semantik',
  bm25: 'Volltext',
  both: 'Semantik + Volltext',
  fuzzy: 'Fuzzy',
}

function MatchBadge({ matched_by }: { matched_by?: string }) {
  if (!matched_by) return null
  const label = MATCH_LABELS[matched_by]
  if (!label) return null
  return <span className={`match-badge match-badge--${matched_by}`}>{label}</span>
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Search({ toast, settings, ollamaReady }: Props) {
  const navigate = useNavigate()
  const [query, setQuery] = useState(() => sessionStorage.getItem('wdb-q') || '')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('')
  const [tagFilter, setTagFilter] = useState<string | null>(null)
  const [threshold, setThreshold] = useState(settings.search_threshold)
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [isFuzzy, setIsFuzzy] = useState(false)
  const [fuzzySuggestion, setFuzzySuggestion] = useState<string | null>(null)
  const [tookMs, setTookMs] = useState(0)
  const [tags, setTags] = useState<Tag[]>([])
  const [llmAnswer, setLlmAnswer] = useState<string | null>(null)
  const [llmSources, setLlmSources] = useState<SearchResult[]>([])
  const [llmBusy, setLlmBusy] = useState(false)
  const [filterOpen, setFilterOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => setThreshold(settings.search_threshold), [settings.search_threshold])
  useEffect(() => { listTags().then(setTags).catch(() => { }) }, [])
  useEffect(() => { inputRef.current?.focus() }, [])

  const runSearch = useCallback(
    async (q: string) => {
      sessionStorage.setItem('wdb-q', q)
      if (!q.trim()) { setResults([]); setLlmAnswer(null); setIsFuzzy(false); setFuzzySuggestion(null); return }
      abortRef.current?.abort()
      abortRef.current = new AbortController()
      setLoading(true)
      setIsFuzzy(false)
      setFuzzySuggestion(null)
      const t0 = performance.now()
      try {
        const r = await search({
          query: q,
          threshold,
          top_k: settings.top_k,
          alpha: settings.hybrid_alpha,
          tags: tagFilter ? [tagFilter] : undefined,
          entry_type: typeFilter || undefined,
        })
        if (r.length === 0) {
          const { results: fuzzy, suggestion } = await fuzzySearch({
            query: q,
            top_k: settings.top_k,
            entry_type: typeFilter || undefined,
          })
          setResults(fuzzy)
          setIsFuzzy(fuzzy.length > 0)
          setFuzzySuggestion(suggestion)
        } else {
          setResults(r)
        }
        setTookMs(performance.now() - t0)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') toast('Suchfehler', 'error')
      } finally {
        setLoading(false)
      }
    },
    [threshold, tagFilter, typeFilter, settings.top_k, settings.hybrid_alpha, toast],
  )

  useEffect(() => { runSearch(query) }, [query, runSearch])
  const onSubmit = (e: React.FormEvent) => { e.preventDefault(); runSearch(query) }

  const llmAbortRef = useRef<AbortController | null>(null)

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
      sources.map((r) => r.id),
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
    }))
    navigate(`/entries/${r.id}`)
  }

  const displayedResults = methodFilter
    ? results.filter(r => r.matched_by === methodFilter || r.matched_by === 'both')
    : results

  const activeFilters = (tagFilter ? 1 : 0) + (typeFilter ? 1 : 0) + (methodFilter ? 1 : 0)
  const noResults = query.trim() && !loading && results.length === 0
  const noDisplayed = query.trim() && !loading && results.length > 0 && displayedResults.length === 0
  const sliderStyle = { '--p': `${threshold * 100}%` } as React.CSSProperties

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

      <div>
        <h5>Suchmethode</h5>
        <div className="mode-track">
          {([['', 'Alle'], ['semantic', 'Semantik'], ['bm25', 'Volltext']] as [MethodFilter, string][]).map(([m, label]) => (
            <button key={m} className={methodFilter === m ? 'on' : ''} onClick={() => { setMethodFilter(m); setFilterOpen(false) }}>
              {label}
            </button>
          ))}
        </div>
      </div>

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

      <div>
        <h5>Tags</h5>
        <div className="tag-list">
          <div className={`tag-row ${tagFilter === null ? 'on' : ''}`} onClick={() => { setTagFilter(null); setFilterOpen(false) }}>
            <span>Alle</span>
            <span className="count">{tags.reduce((s, t) => s + t.count, 0)}</span>
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
              <button type="button" className="clear" onClick={() => { setQuery(''); setResults([]); setLlmAnswer(null); setIsFuzzy(false); setFuzzySuggestion(null) }}>×</button>
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

        {query.trim() && (
          <div className="meta-line">
            <span>
              {loading ? 'Suche…'
                : `${displayedResults.length} Ergebnis${displayedResults.length !== 1 ? 'se' : ''} · ${Math.round(tookMs)}ms`}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {tagFilter && (
                <span className="filters">
                  <button className="filter-chip" onClick={() => setTagFilter(null)}>
                    {tagFilter} <span className="x">×</span>
                  </button>
                </span>
              )}
              {ollamaReady && displayedResults.length > 0 && (
                <button className="btn btn--ghost btn--sm" onClick={askLlm}>
                  {llmBusy ? '✕ Abbrechen' : '✦ KI-Zusammenfassung'}
                </button>
              )}
            </div>
          </div>
        )}

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
            {!llmBusy && llmSources.length > 0 && (
              <div className="llm-sources">
                {llmSources.map((s, i) => (
                  <button key={s.id} className="llm-source-item" onClick={() => navigate(`/entries/${s.id}`)}>
                    <span className="llm-source-n">{i + 1}</span>
                    <span className="llm-source-title">{s.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {query.trim() ? (
          noResults ? (
            <div className="empty">
              <h3>Keine Ergebnisse</h3>
              <p>Auch die Fuzzy-Suche liefert keine Treffer. Versuche andere Begriffe.</p>
            </div>
          ) : noDisplayed ? (
            <div className="empty">
              <h3>Keine Treffer mit diesem Filter</h3>
              <p>
                <button className="btn btn--ghost btn--sm" onClick={() => setMethodFilter('')}>Filter zurücksetzen</button>
              </p>
            </div>
          ) : !loading && displayedResults.length > 0 ? (
            <>
              {isFuzzy && (
                <div className="fuzzy-hint">
                  {fuzzySuggestion ? (
                    <>
                      Meintest du{' '}
                      <button className="suggest-correction" onClick={() => setQuery(fuzzySuggestion)}>
                        {fuzzySuggestion}
                      </button>
                      ? — ähnliche Ergebnisse:
                    </>
                  ) : (
                    'Kein exakter Treffer — ähnliche Ergebnisse (Fuzzy-Suche):'
                  )}
                </div>
              )}
              <div className="results">
                {displayedResults.map((r) => (
                  <article key={r.id} className="result" onClick={() => handleResultClick(r)} role="button">
                    <ScoreBar score={r.score} />
                    <div>
                      <h3 className="q">{renderTitle(r.title, query, r.matched_by)}</h3>
                      <p className="snippet">{renderSnippet(r.snippet, r.highlight_spans)}</p>
                      <div className="meta-row">
                        <EntryTypeBadge type={r.entry_type} />
                        <MatchBadge matched_by={r.matched_by} />
                        {r.tags.map((t) => <span className="chip" key={t}>{t}</span>)}
                      </div>
                    </div>
                    <div className="right-side"><span>{r.call_count}×</span></div>
                  </article>
                ))}
              </div>
            </>
          ) : null
        ) : (
          <div className="empty-search">
            <div className="empty-search-head">
              <h2>Was möchtest du wissen?</h2>
              <p>Suche mit natürlicher Sprache. <em>Semantische Bedeutung</em> und <em>Volltext-Suche</em> arbeiten gemeinsam am Ergebnis.</p>
            </div>
            {tags.length > 0 && (
              <>
                <p className="section-h">Themen</p>
                <div className="suggest-grid">
                  {tags.slice(0, 8).map((t) => (
                    <button key={t.name} className="suggest" onClick={() => { setTagFilter(t.name); setQuery(t.name) }}>
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
