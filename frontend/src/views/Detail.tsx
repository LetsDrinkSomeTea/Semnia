import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getEntry, deleteEntry } from '../api/client'
import type { Entry } from '../types'
import EntryTypeBadge from '../components/EntryTypeBadge'
import EntryRow from '../components/EntryRow'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

export default function Detail({ toast }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [entry, setEntry] = useState<Entry | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!id) return
    getEntry(Number(id))
      .then(setEntry)
      .catch(() => toast('Eintrag nicht gefunden', 'error'))
      .finally(() => setLoading(false))
  }, [id])

  const handleDelete = async () => {
    if (!entry || !confirm('Eintrag wirklich löschen?')) return
    await deleteEntry(entry.id)
    toast('Eintrag gelöscht', 'success')
    navigate(-1)
  }

  if (loading) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>
  if (!entry) return <main className="pb-main"><div className="empty"><h3>Nicht gefunden</h3></div></main>

  const isQA = entry.entry_type === 'qa'

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
                <div className="detail-body">{entry.question}</div>
              </div>
            )}
            {entry.answer && (
              <div className="detail-section">
                <div className="detail-section-label">Antwort</div>
                <div className="detail-body">{entry.answer}</div>
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
            <div className="detail-body">{entry.content}</div>
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
