import React, { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { summarizeStream } from '../api/client'
import { extractCitedNums, renderWithCitations } from '../utils/textFormatting'
import SearchResultItem from '../components/SearchResultItem'
import type { SearchResult } from '../types'

type Props = { toast: (msg: string, type?: 'info' | 'success' | 'error') => void }

interface ToolStep {
  id: string
  tool: string
  args?: string
  title?: string
  status: 'calling' | 'done'
}

interface Turn {
  query: string
  steps: ToolStep[]
  results: SearchResult[]
  summary: string    // short agent summary
  failureReason?: string
  done: boolean
  // LLM summarization (reuses existing summarize endpoint)
  llmAnswer: string | null
  llmBusy: boolean
  llmSources: SearchResult[]
}

function emptyTurn(query: string): Turn {
  return { query, steps: [], results: [], summary: '', done: false, llmAnswer: null, llmBusy: false, llmSources: [] }
}

export default function AgenticSearch({ toast }: Props) {
  const navigate = useNavigate()
  const initialQuery = new URLSearchParams(window.location.search).get('q') || ''
  const [query, setQuery] = useState(initialQuery)
  const [running, setRunning] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])

  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const llmAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [turns, running])

  // ── Immutable turn updater ─────────────────────────────────────────────────
  const updateLastTurn = (fn: (t: Turn) => Turn) => {
    setTurns(prev => {
      const next = [...prev]
      next[next.length - 1] = fn({ ...next[next.length - 1] })
      return next
    })
  }

  // ── Run agent ──────────────────────────────────────────────────────────────
  const runAgent = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    if (!query.trim() || running) return

    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setRunning(true)

    // Build history from previous turns
    const history = turns.flatMap(t => [
      { role: 'user', content: t.query },
      ...(t.summary ? [{ role: 'assistant', content: t.summary }] : [])
    ])

    const newTurn = emptyTurn(query)
    setTurns(prev => [...prev, newTurn])
    const currentQuery = query
    setQuery('')

    try {
      const API_URL = import.meta.env.VITE_API_URL || '/api'
      const res = await fetch(`${API_URL}/ai/agent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: currentQuery, history }),
        signal: ctrl.signal,
      })

      if (!res.body) throw new Error('No body')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const lines = decoder.decode(value).split('\n')

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const dataStr = line.slice(6)
          if (!dataStr.trim()) continue
          try {
            const payload = JSON.parse(dataStr)

            if (payload.type === 'results') {
              // SearchResult objects from the side-channel
              updateLastTurn(t => ({
                ...t,
                results: deduplicateResults([...t.results, ...payload.items])
              }))
            } else if (payload.type === 'tool_call') {
              updateLastTurn(t => {
                const existing = t.steps.findIndex(s => s.id === payload.call_id)
                if (existing === -1) {
                  return { ...t, steps: [...t.steps, { id: payload.call_id, tool: payload.tool, args: payload.args, title: payload.title, status: 'calling' }] }
                } else {
                  const nextSteps = [...t.steps]
                  nextSteps[existing] = { ...nextSteps[existing], args: payload.args, title: payload.title || nextSteps[existing].title }
                  return { ...t, steps: nextSteps }
                }
              })
            } else if (payload.type === 'tool_result') {
              updateLastTurn(t => ({
                ...t,
                steps: t.steps.map(s => s.id === payload.call_id ? { ...s, status: 'done' as const } : s)
              }))
            } else if (payload.type === 'message') {
              updateLastTurn(t => ({ ...t, summary: t.summary + payload.text }))
            } else if (payload.type === 'failure') {
              updateLastTurn(t => ({ ...t, failureReason: payload.message, done: true }))
            } else if (payload.type === 'done') {
              updateLastTurn(t => ({ ...t, done: true }))
            }
          } catch {}
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        toast('Fehler beim Ausführen des Agenten', 'error')
      }
    } finally {
      updateLastTurn(t => ({ ...t, done: true }))
      setRunning(false)
      abortRef.current = null
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    setRunning(false)
  }

  // ── Summarize (reuses existing endpoint) ───────────────────────────────────
  const askLlm = (turnIdx: number) => {
    const turn = turns[turnIdx]
    if (!turn || turn.results.length === 0) return

    if (turn.llmBusy) {
      llmAbortRef.current?.abort()
      llmAbortRef.current = null
      setTurns(prev => {
        const next = [...prev]
        next[turnIdx] = { ...next[turnIdx], llmBusy: false }
        return next
      })
      return
    }

    const sources = turn.results.slice(0, 5)
    setTurns(prev => {
      const next = [...prev]
      next[turnIdx] = { ...next[turnIdx], llmAnswer: '', llmBusy: true, llmSources: sources }
      return next
    })

    const ctrl = new AbortController()
    llmAbortRef.current = ctrl

    summarizeStream(
      sources.map(r => ({ entry_id: r.id, chunk_id: r.matched_chunk_id })),
      turn.query,
      (token) => setTurns(prev => {
        const next = [...prev]
        next[turnIdx] = { ...next[turnIdx], llmAnswer: (next[turnIdx].llmAnswer ?? '') + token }
        return next
      }),
      () => setTurns(prev => {
        const next = [...prev]
        next[turnIdx] = { ...next[turnIdx], llmBusy: false }
        return next
      }),
      (msg) => { toast(msg, 'error'); setTurns(prev => { const next = [...prev]; next[turnIdx] = { ...next[turnIdx], llmBusy: false }; return next }) },
      ctrl.signal,
    )
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const handleResultClick = (r: SearchResult) => {
    sessionStorage.setItem(`highlight-${r.id}`, JSON.stringify({
      query: turns[turns.length - 1]?.query || '',
      matched_by: r.matched_by,
      matched_chunk_type: r.matched_chunk_type,
      snippet: r.snippet,
    }))
    navigate(`/entries/${r.id}`)
  }

  return (
    <div className="pb-body no-side">
      <main className="pb-main">
        <div style={{ maxWidth: 900, margin: '0 auto', width: '100%' }}>
          <h2 style={{ marginBottom: 24 }}>Agentic Search</h2>

          {turns.length === 0 && !running && (
            <div style={{ textAlign: 'center', color: 'var(--c-text-muted)', marginTop: 48, marginBottom: 32 }}>
              <p style={{ fontSize: '1.1rem' }}>Stelle eine Frage, und der Agent durchsucht autonom die Wissensdatenbank.</p>
            </div>
          )}

          {turns.map((turn, tIdx) => (
            <div key={tIdx} style={{ marginBottom: 32 }}>
              {/* Question header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--c-text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Frage {tIdx + 1}</span>
                <span style={{ fontSize: '1rem', fontWeight: 500 }}>{turn.query}</span>
              </div>



              {/* Results as SearchResultItem cards */}
              {turn.results.length > 0 && (
                <div className="results" style={{ marginTop: 12 }}>
                  {turn.results.map(r => (
                    <SearchResultItem
                      key={r.id}
                      result={r}
                      onClick={handleResultClick}
                      onClickTag={() => {}}
                    />
                  ))}
                </div>
              )}

              {/* Failure Message */}
              {turn.failureReason && (
                <div style={{ padding: '16px', backgroundColor: '#fff0f4', border: '1px solid #ffccd5', borderRadius: '8px', color: '#c00030', marginTop: '12px' }}>
                  <strong>⚠ Agent hat die Suche abgebrochen:</strong> {turn.failureReason}
                </div>
              )}

              {/* Agent summary */}
              {turn.summary && turn.done && (
                <div style={{ fontSize: '0.9rem', color: 'var(--c-text-muted)', marginTop: 8, fontStyle: 'italic' }}>
                  {turn.summary}
                </div>
              )}

              {/* Summarize button + LLM card */}
              {turn.done && turn.results.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <button className="btn btn--ghost btn--sm" onClick={() => askLlm(tIdx)}>
                    {turn.llmBusy ? '✕ Abbrechen' : '✦ KI-Zusammenfassung'}
                  </button>

                  {turn.llmAnswer !== null && (
                    <div className="llm-card" style={{ marginTop: 12 }}>
                      <div className="llm-head">
                        <span className="badge">KI-Zusammenfassung</span>
                        <button className="x-btn" onClick={() => {
                          llmAbortRef.current?.abort()
                          setTurns(prev => { const next = [...prev]; next[tIdx] = { ...next[tIdx], llmAnswer: null, llmBusy: false }; return next })
                        }}>×</button>
                      </div>
                      <p className="answer">
                        {renderWithCitations(turn.llmAnswer, turn.llmSources, (id) => navigate(`/entries/${id}`))}
                        {turn.llmBusy && <span className="llm-cursor" />}
                      </p>
                      {!turn.llmBusy && turn.llmSources.length > 0 && (() => {
                        const cited = extractCitedNums(turn.llmAnswer ?? '')
                        const usedSources = turn.llmSources
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
                </div>
              )}

              {/* Divider between turns */}
              {tIdx < turns.length - 1 && (
                <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '24px 0' }} />
              )}
            </div>
          ))}

          {/* Loading indicator */}
          {running && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--c-text-muted)', marginBottom: 16 }}>
              <span style={{ display: 'inline-block', animation: 'spin 2s linear infinite' }}>⚙</span>
              <span>
                {(() => {
                  const currentTurn = turns[turns.length - 1];
                  if (!currentTurn || currentTurn.steps.length === 0) return 'Agent überlegt...';
                  const lastStep = currentTurn.steps[currentTurn.steps.length - 1];
                  
                  let args: any = {};
                  try {
                    if (lastStep.args) args = JSON.parse(lastStep.args);
                  } catch (e) {
                    if (typeof lastStep.args === 'string') {
                      const qMatch = lastStep.args.match(/"query"\s*:\s*"([^"]+)/);
                      if (qMatch) args.query = qMatch[1];
                      const idMatch = lastStep.args.match(/"entry_id"\s*:\s*(\d+)/);
                      if (idMatch) args.entry_id = idMatch[1];
                    }
                  }
                  
                  if (lastStep.tool === 'search_database') {
                    return <>Durchsuche die Datenbank nach: <i>{args.query || '...'}</i>...</>;
                  } else if (lastStep.tool === 'read_document') {
                    return <>Lese vollständiges Dokument <i>{lastStep.title || args.entry_id || ''}</i>...</>;
                  } else if (lastStep.tool === 'mark_source_as_relevant') {
                    return <>Markiere Dokument <i>{lastStep.title || args.entry_id || ''}</i> als relevant...</>;
                  } else {
                    return <>Führe Aktion aus: <i>{lastStep.tool}</i>...</>;
                  }
                })()}
              </span>
              <button className="btn btn--ghost btn--sm" onClick={cancel} style={{ marginLeft: 'auto' }}>Abbrechen</button>
            </div>
          )}

          <div ref={bottomRef} />

          {/* Query input */}
          <form onSubmit={runAgent} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <div className="search-shell" style={{ flex: 1, margin: 0 }}>
              <span className="icon">
                <svg width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={turns.length === 0 ? 'Wonach suchst du?' : 'Folgefrage stellen…'}
                autoComplete="off"
                spellCheck={false}
                disabled={running}
              />
              {query && (
                <button type="button" className="clear" onClick={() => setQuery('')}>×</button>
              )}
            </div>
            <button type="submit" className="btn btn--primary" disabled={!query.trim() || running}>
              {turns.length === 0 ? 'Suchen' : 'Fragen'}
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}

/** Deduplicate results by entry ID, keeping the one with the highest score */
function deduplicateResults(results: SearchResult[]): SearchResult[] {
  const map = new Map<number, SearchResult>()
  for (const r of results) {
    const existing = map.get(r.id)
    if (!existing || r.score > existing.score) {
      map.set(r.id, r)
    }
  }
  return Array.from(map.values()).sort((a, b) => b.score - a.score)
}
