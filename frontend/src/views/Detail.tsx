import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getEntry, deleteEntry } from '../api/client'
import type { Entry } from '../types'
import EntryTypeBadge from '../components/EntryTypeBadge'
import EntryRow from '../components/EntryRow'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

interface HlCtx {
  query: string
  matched_by?: string
  matched_chunk_type?: string
}

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

function renderWithHighlight(text: string, query: string, firstMarkRef: React.MutableRefObject<Element | null>): React.ReactNode {
  const words = query.split(/\s+/).filter(w => w.length > 2).map(w => w.toLowerCase())
  const spans = computeSpans(text, words)
  if (!spans.length) return text

  const parts: React.ReactNode[] = []
  let cursor = 0
  let firstSet = false
  const sorted = [...spans].sort((a, b) => a[0] - b[0])
  for (const [s, e] of sorted) {
    if (s < cursor) continue
    if (s > cursor) parts.push(text.slice(cursor, s))
    const isFirst = !firstSet
    firstSet = true
    parts.push(
      <mark
        key={s}
        ref={isFirst ? (el) => { firstMarkRef.current = el } : undefined}
      >
        {text.slice(s, e)}
      </mark>
    )
    cursor = e
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

export default function Detail({ toast }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [entry, setEntry] = useState<Entry | null>(null)
  const [loading, setLoading] = useState(true)
  const [hlCtx, setHlCtx] = useState<HlCtx | null>(null)
  const firstMarkRef = useRef<Element | null>(null)

  useEffect(() => {
    if (!id) return
    const stored = sessionStorage.getItem(`highlight-${id}`)
    if (stored) { try { setHlCtx(JSON.parse(stored)) } catch {} }
    getEntry(Number(id))
      .then(setEntry)
      .catch(() => toast('Eintrag nicht gefunden', 'error'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    if (!entry || !hlCtx) return
    const el = firstMarkRef.current
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [entry, hlCtx])

  const handleDelete = async () => {
    if (!entry || !confirm('Eintrag wirklich löschen?')) return
    await deleteEntry(entry.id)
    toast('Eintrag gelöscht', 'success')
    navigate(-1)
  }

  if (loading) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>
  if (!entry) return <main className="pb-main"><div className="empty"><h3>Nicht gefunden</h3></div></main>

  const isQA = entry.entry_type === 'qa'
  const shouldHighlight = hlCtx && hlCtx.matched_by && hlCtx.matched_by !== 'semantic'
  const mct = hlCtx?.matched_chunk_type

  const hl = (text: string | null) => {
    if (!text) return null
    if (!shouldHighlight || !hlCtx) return text
    return renderWithHighlight(text, hlCtx.query, firstMarkRef)
  }

  return (
    <main className="pb-main">
      <button className="detail-back" onClick={() => navigate(-1)}>← Zurück</button>

      <div className="detail">
        <div>
          <div className="detail-meta-row" style={{ marginBottom: 10 }}>
            <EntryTypeBadge type={entry.entry_type} />
            {entry.tags.map((t) => (
              <span className="chip" key={t}>{t}</span>
            ))}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, marginLeft: 4 }}>
              {entry.call_count}× aufgerufen
            </span>
          </div>
          <h1>{entry.title}</h1>
        </div>

        {isQA ? (
          <>
            {entry.question && (
              <div className="detail-section">
                <div className="detail-section-label">Frage</div>
                <div className="detail-body">{mct === 'question' ? hl(entry.question) : entry.question}</div>
              </div>
            )}
            {entry.answer && (
              <div className="detail-section">
                <div className="detail-section-label">Antwort</div>
                <div className="detail-body">{mct === 'answer' || mct === 'content' ? hl(entry.answer) : entry.answer}</div>
              </div>
            )}
          </>
        ) : (
          <div className="detail-section">
            {entry.source_filename && (
              <div className="detail-meta-row" style={{ marginBottom: 10 }}>
                <span style={{ fontSize: 11, color: 'var(--primary--500)' }}>
                  📄 {entry.source_filename}
                </span>
              </div>
            )}
            <div className="detail-body">{hl(entry.content)}</div>
          </div>
        )}

        <div className="detail-actions">
          {isQA && (
            <button className="btn btn--ghost" onClick={() => navigate(`/editor/${entry.id}`)}>
              Bearbeiten
            </button>
          )}
          <button className="btn btn--ghost" onClick={handleDelete} style={{ marginLeft: 'auto' }}>
            Löschen
          </button>
        </div>
      </div>

      {entry.related && entry.related.length > 0 && (
        <div className="related">
          <h4>Verwandte Einträge</h4>
          <div className="entry-list">
            {entry.related.map((r) => (
              <EntryRow
                key={r.id}
                title={r.title}
                entry_type={r.entry_type}
                onClick={() => navigate(`/entries/${r.id}`)}
              />
            ))}
          </div>
        </div>
      )}
    </main>
  )
}
