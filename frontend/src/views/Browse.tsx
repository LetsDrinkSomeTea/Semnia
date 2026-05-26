import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { listEntries, listTags, getStatus } from '../api/client'
import type { Entry, Tag } from '../types'
import EntryTypeBadge from '../components/EntryTypeBadge'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

type TypeFilter = '' | 'qa' | 'document'

export default function Browse({ toast }: Props) {
  const navigate = useNavigate()
  const [tags, setTags] = useState<Tag[]>([])
  const [recent, setRecent] = useState<Entry[]>([])
  const [popular, setPopular] = useState<Entry[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [entryCount, setEntryCount] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([
      listTags(),
      listEntries({ per_page: 10, sort: 'updated' }),
      listEntries({ per_page: 10, sort: 'calls' }),
      getStatus(),
    ])
      .then(([t, r, p, s]) => {
        setTags(t)
        setRecent(r.items)
        setPopular(p.items)
        setEntryCount(s.entry_count)
      })
      .catch(() => toast('Fehler beim Laden', 'error'))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (activeTag !== null || typeFilter) {
      listEntries({ per_page: 20, tag: activeTag ?? undefined, entry_type: typeFilter || undefined, sort: 'updated' })
        .then((r) => setRecent(r.items))
        .catch(() => {})
    }
  }, [activeTag, typeFilter])

  const qaCount = tags.reduce((s, _) => s, 0)

  if (loading) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>

  return (
    <main className="pb-main">
      {/* Hero */}
      <div className="browse-hero">
        <div className="hero-num">{entryCount}</div>
        <div>
          <h2>Wissensdatenbank</h2>
          <p>Alle Einträge auf einen Blick — durchsuche nach Thema oder Typ.</p>
        </div>
        <div className="hero-stats">
          <div>
            <span className="n">{tags.length}</span>
            <span className="l">Tags</span>
          </div>
          <div>
            <span className="n">{recent.length}</span>
            <span className="l">Aktuell</span>
          </div>
        </div>
      </div>

      {/* Type filter */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <p className="section-h" style={{ margin: 0 }}>Typ</p>
        <div className="mode-track" style={{ width: 220 }}>
          {(['', 'qa', 'document'] as TypeFilter[]).map((t) => (
            <button
              key={t}
              className={typeFilter === t ? 'on' : ''}
              onClick={() => setTypeFilter(t)}
            >
              {t === '' ? 'Alle' : t === 'qa' ? 'Q&A' : 'Dokumente'}
            </button>
          ))}
        </div>
      </div>

      {/* Tag cards */}
      {tags.length > 0 && (
        <>
          <p className="section-h">Themen</p>
          <div className="browse-grid">
            {tags.map((tag) => {
              const initials = tag.name
                .split(/\s+/)
                .map((w) => w[0]?.toUpperCase() ?? '')
                .join('')
                .slice(0, 3)
              return (
                <div
                  key={tag.name}
                  className={`cat-card ${activeTag === tag.name ? 'on' : ''}`}
                  onClick={() => setActiveTag(activeTag === tag.name ? null : tag.name)}
                  role="button"
                >
                  <div className="ic">{initials}</div>
                  <h5>{tag.name}</h5>
                  <span className="cnt">{tag.count} Einträge</span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* Recent + Popular */}
      <div className="browse-cols">
        <div>
          <p className="section-h">Zuletzt aktualisiert</p>
          <div className="recent-list">
            {recent.length === 0 ? (
              <div className="empty" style={{ padding: '20px' }}>
                <p>Keine Einträge</p>
              </div>
            ) : (
              recent.map((e) => (
                <div
                  key={e.id}
                  className="recent-row"
                  onClick={() => navigate(`/entries/${e.id}`)}
                  role="button"
                >
                  <span className="q">{e.title}</span>
                  <EntryTypeBadge type={e.entry_type} />
                  <span className="meta">
                    {e.updated_at ? new Date(e.updated_at).toLocaleDateString('de-DE') : '—'}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <p className="section-h">Am häufigsten abgerufen</p>
          <div className="recent-list">
            {popular.filter((e) => e.call_count > 0).length === 0 ? (
              <div className="empty" style={{ padding: '20px' }}>
                <p>Noch keine Aufrufe</p>
              </div>
            ) : (
              popular
                .filter((e) => e.call_count > 0)
                .map((e) => (
                  <div
                    key={e.id}
                    className="recent-row"
                    onClick={() => navigate(`/entries/${e.id}`)}
                    role="button"
                  >
                    <span className="q">{e.title}</span>
                    <EntryTypeBadge type={e.entry_type} />
                    <span className="meta">{e.call_count}×</span>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
