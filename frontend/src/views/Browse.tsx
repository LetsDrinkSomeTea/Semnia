import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { listEntries, listTags } from '../api/client'
import type { Entry, Tag } from '../types'
import EntryRow from '../components/EntryRow'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

type TypeFilter = '' | 'qa' | 'document'
type SortMode = 'updated' | 'calls'

export default function Browse({ toast }: Props) {
  const navigate = useNavigate()
  const [tags, setTags] = useState<Tag[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('')
  const [sort, setSort] = useState<SortMode>('updated')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    listTags().then(setTags).catch(() => {})
  }, [])

  useEffect(() => {
    setLoading(true)
    listEntries({
      per_page: 40,
      tag: activeTag ?? undefined,
      entry_type: typeFilter || undefined,
      sort,
    })
      .then((r) => setEntries(r.items))
      .catch(() => toast('Fehler beim Laden', 'error'))
      .finally(() => setLoading(false))
  }, [activeTag, typeFilter, sort])

  const formatMeta = (e: Entry): string => {
    if (sort === 'calls') return e.call_count > 0 ? `${e.call_count}×` : '—'
    return e.updated_at ? new Date(e.updated_at).toLocaleDateString('de-DE') : '—'
  }

  return (
    <main className="pb-main">
      {/* Toolbar */}
      <div className="browse-toolbar">
        <div className="mode-track">
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
        <button className="btn" onClick={() => navigate('/editor/new')}>
          + Neuer Eintrag
        </button>
      </div>

      {/* Tag filter chips */}
      {tags.length > 0 && (
        <div className="tag-chip-row">
          {tags.map((tag) => (
            <button
              key={tag.name}
              className={`tag-filter-chip ${activeTag === tag.name ? 'on' : ''}`}
              onClick={() => setActiveTag(activeTag === tag.name ? null : tag.name)}
            >
              {tag.name}
              <span className="chip-count">{tag.count}</span>
              {activeTag === tag.name && <span className="chip-x">×</span>}
            </button>
          ))}
        </div>
      )}

      {/* Count + sort */}
      <div className="browse-meta">
        <span className="browse-count">
          {loading ? '…' : `${entries.length} Einträge`}
          {activeTag && <span className="browse-tag-label"> · {activeTag}</span>}
        </span>
        <div className="sort-tabs">
          <button className={sort === 'updated' ? 'on' : ''} onClick={() => setSort('updated')}>
            Zuletzt
          </button>
          <button className={sort === 'calls' ? 'on' : ''} onClick={() => setSort('calls')}>
            Beliebt
          </button>
        </div>
      </div>

      {/* Entry list */}
      {loading ? (
        <div className="empty"><p>Lädt…</p></div>
      ) : entries.length === 0 ? (
        <div className="empty">
          <h3>Keine Einträge</h3>
          <p>
            {activeTag || typeFilter
              ? 'Keine Einträge für diesen Filter.'
              : 'Noch keine Einträge vorhanden. Erstelle den ersten!'}
          </p>
        </div>
      ) : (
        <div className="entry-list">
          {entries.map((e) => (
            <EntryRow
              key={e.id}
              title={e.title}
              entry_type={e.entry_type}
              meta={formatMeta(e)}
              onClick={() => navigate(`/entries/${e.id}`)}
            />
          ))}
        </div>
      )}
    </main>
  )
}
