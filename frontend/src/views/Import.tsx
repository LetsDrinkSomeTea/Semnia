import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  uploadFile, listImports, getImportStatus, deleteImport,
  parseQACsv, confirmQAImport,
} from '../api/client'
import type { ImportItem } from '../types'
import type { QABulkRow, QABulkAction } from '../api/client'
import TagInput from '../components/TagInput'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

interface UploadState {
  file: string
  entry_id: number | null
  chunk_count: number
  embedded_count: number
  done: boolean
  error: string | null
}

interface ReviewRow extends QABulkRow {
  action: 'import' | 'skip' | 'replace'
  replace_id?: number
  expanded: boolean
}

// ── Document import tab ────────────────────────────────────────────────────────

function DocImport({ toast }: Props) {
  const navigate = useNavigate()
  const [over, setOver] = useState(false)
  const [imports, setImports] = useState<ImportItem[]>([])
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [loading, setLoading] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadImports = useCallback(() => {
    listImports()
      .then((r) => setImports(r.items))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { loadImports() }, [])

  useEffect(() => {
    const pending = uploads.filter((u) => !u.done && u.entry_id)
    if (!pending.length) {
      if (pollRef.current) clearInterval(pollRef.current)
      return
    }
    pollRef.current = setInterval(async () => {
      for (const u of pending) {
        if (!u.entry_id) continue
        const s = await getImportStatus(u.entry_id).catch(() => null)
        if (!s) continue
        setUploads((prev) =>
          prev.map((p) =>
            p.entry_id === u.entry_id
              ? { ...p, embedded_count: s.embedded_count, done: s.done }
              : p,
          ),
        )
        if (s.done) loadImports()
      }
    }, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [uploads, loadImports])

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!['md', 'pdf', 'docx', 'doc'].includes(ext ?? '')) {
        toast(`Format nicht unterstützt: .${ext}`, 'error')
        continue
      }
      const state: UploadState = { file: file.name, entry_id: null, chunk_count: 0, embedded_count: 0, done: false, error: null }
      setUploads((prev) => [...prev, state])
      try {
        const result = await uploadFile(file)
        setUploads((prev) =>
          prev.map((u) =>
            u.file === file.name && u.entry_id === null
              ? { ...u, entry_id: result.entry_id, chunk_count: result.chunk_count }
              : u,
          ),
        )
        toast(`"${result.title}" importiert (${result.chunk_count} Abschnitte)`, 'success')
        loadImports()
      } catch (e) {
        setUploads((prev) =>
          prev.map((u) =>
            u.file === file.name && u.entry_id === null
              ? { ...u, done: true, error: (e as Error).message }
              : u,
          ),
        )
        toast(`Fehler: ${(e as Error).message}`, 'error')
      }
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setOver(false)
    if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files)
  }

  const onDelete = async (id: number) => {
    if (!confirm('Dokument wirklich löschen?')) return
    await deleteImport(id)
    setImports((prev) => prev.filter((i) => i.id !== id))
    toast('Dokument gelöscht', 'success')
  }

  const ext = (filename: string) => filename.split('.').pop()?.toUpperCase() ?? '?'

  return (
    <>
      <div
        className={`import-drop ${over ? 'over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
      >
        <div className="big-ic">+</div>
        <h3>Dateien hierher ziehen</h3>
        <p>oder klicken zum Auswählen — MD, PDF, DOCX</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.pdf,.docx,.doc"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => e.target.files && handleFiles(e.target.files)}
        />
      </div>

      {uploads.length > 0 && (
        <>
          <p className="section-h">Aktueller Upload</p>
          <div className="import-queue">
            {uploads.map((u, i) => {
              const pct = u.chunk_count > 0 ? Math.round((u.embedded_count / u.chunk_count) * 100) : 0
              return (
                <div className="queue-row" key={i}>
                  <span className="ext">{ext(u.file)}</span>
                  <span className="name">{u.file}</span>
                  <div className="bar">
                    <div className="fill" style={{ width: u.error ? '100%' : u.chunk_count === 0 ? '10%' : `${pct}%`, background: u.error ? 'var(--base--action)' : undefined }} />
                  </div>
                  <span className={`stat ${u.done && !u.error ? 'done' : ''}`}>
                    {u.error ? 'Fehler' : u.done ? 'Fertig' : u.chunk_count === 0 ? 'Lädt…' : `${u.embedded_count}/${u.chunk_count}`}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {loading ? (
        <div className="empty"><p>Lädt…</p></div>
      ) : imports.length > 0 ? (
        <>
          <p className="section-h">Importierte Dokumente</p>
          <div className="import-queue">
            {imports.map((item) => {
              const pct = item.chunk_count > 0 ? Math.round((item.embedded_count / item.chunk_count) * 100) : 100
              return (
                <div className="queue-row" key={item.id} style={{ gridTemplateColumns: '52px 1fr 140px 100px 80px' }}>
                  <span className="ext">{ext(item.source_filename)}</span>
                  <span className="name" style={{ cursor: 'pointer', color: 'var(--base--action)' }} onClick={() => navigate(`/entries/${item.id}`)}>
                    {item.title}
                  </span>
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className={`stat ${item.embedded_count >= item.chunk_count ? 'done' : ''}`}>
                    {item.embedded_count >= item.chunk_count ? 'Indexiert' : `${item.embedded_count}/${item.chunk_count}`}
                  </span>
                  <div className="queue-actions">
                    <button className="btn btn--ghost btn--sm" onClick={() => onDelete(item.id)}>×</button>
                  </div>
                </div>
              )
            })}
          </div>
        </>
      ) : (
        <div className="empty">
          <h3>Noch keine Dokumente</h3>
          <p>Lade Dateien hoch, um sie durchsuchbar zu machen.</p>
        </div>
      )}
    </>
  )
}

// ── Q&A bulk import tab ────────────────────────────────────────────────────────

function QABulkImport({ toast }: Props) {
  const [parsing, setParsing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rows, setRows] = useState<ReviewRow[] | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFile = async (file: File) => {
    if (!file.name.endsWith('.csv')) {
      toast('Nur CSV-Dateien unterstützt', 'error')
      return
    }
    setParsing(true)
    setRows(null)
    try {
      const result = await parseQACsv(file)
      setRows(
        result.rows.map((r) => ({
          ...r,
          action: r.duplicates.length > 0 ? 'skip' : 'import',
          replace_id: r.duplicates[0]?.id,
          expanded: r.duplicates.length > 0,
        })),
      )
    } catch (e) {
      toast(`Fehler beim Parsen: ${(e as Error).message}`, 'error')
    } finally {
      setParsing(false)
    }
  }

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleFile(e.target.files[0])
    e.target.value = ''
  }

  const setAction = (i: number, action: ReviewRow['action'], replaceId?: number) => {
    setRows((prev) => prev!.map((r, idx) => idx === i ? { ...r, action, replace_id: replaceId ?? r.replace_id } : r))
  }

  const setTags = (i: number, tags: string[]) => {
    setRows((prev) => prev!.map((r, idx) => idx === i ? { ...r, tags } : r))
  }

  const setExpanded = (i: number, expanded: boolean) => {
    setRows((prev) => prev!.map((r, idx) => idx === i ? { ...r, expanded } : r))
  }

  const bulkAllNew = () => {
    setRows((prev) => prev!.map((r) => r.duplicates.length === 0 ? { ...r, action: 'import' } : r))
  }

  const bulkSkipDupes = () => {
    setRows((prev) => prev!.map((r) => r.duplicates.length > 0 ? { ...r, action: 'skip' } : r))
  }

  const handleConfirm = async () => {
    if (!rows) return
    setConfirming(true)
    const items: QABulkAction[] = rows.map((r) => ({
      question: r.question,
      answer: r.answer,
      tags: r.tags,
      action: r.action,
      replace_id: r.action === 'replace' ? r.replace_id : undefined,
    }))
    try {
      const result = await confirmQAImport(items)
      toast(`${result.imported} importiert, ${result.replaced} ersetzt, ${result.skipped} übersprungen`, 'success')
      setRows(null)
    } catch (e) {
      toast(`Fehler: ${(e as Error).message}`, 'error')
    } finally {
      setConfirming(false)
    }
  }

  if (!rows) {
    return (
      <div className="qa-bulk-upload">
        <div className="import-drop" onClick={() => fileInputRef.current?.click()} style={{ cursor: 'pointer' }}>
          <div className="big-ic">{parsing ? '⟳' : '↑'}</div>
          <h3>{parsing ? 'Wird analysiert…' : 'CSV-Datei auswählen'}</h3>
          <p>Format: <code>question, answer, tags</code> — Tags kommasepariert in einer Zelle</p>
          <input ref={fileInputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={onFileChange} disabled={parsing} />
        </div>

        <div className="qa-bulk-hint">
          <p className="section-h">CSV-Format</p>
          <pre className="code-block">{`question,answer,tags\n"Was ist XY?","XY ist ein System das...","tag1,tag2"\n"Wie funktioniert Z?","Z funktioniert durch...","tag3"`}</pre>
        </div>
      </div>
    )
  }

  const newCount = rows.filter((r) => r.action === 'import').length
  const skipCount = rows.filter((r) => r.action === 'skip').length
  const replaceCount = rows.filter((r) => r.action === 'replace').length
  const dupeCount = rows.filter((r) => r.duplicates.length > 0).length

  return (
    <div className="qa-review">
      <div className="qa-review-bar">
        <div className="qa-review-stats">
          <span>{rows.length} Einträge</span>
          {dupeCount > 0 && <span className="qa-stat-warn">{dupeCount} Duplikate</span>}
          <span className="qa-stat-new">{newCount} importieren</span>
          {replaceCount > 0 && <span className="qa-stat-replace">{replaceCount} ersetzen</span>}
          {skipCount > 0 && <span className="qa-stat-skip">{skipCount} überspringen</span>}
        </div>
        <div className="qa-review-actions">
          <button className="btn btn--ghost btn--sm" onClick={bulkAllNew}>Alle Neuen importieren</button>
          {dupeCount > 0 && <button className="btn btn--ghost btn--sm" onClick={bulkSkipDupes}>Duplikate überspringen</button>}
          <button className="btn btn--ghost btn--sm" onClick={() => setRows(null)}>Neue Datei</button>
          <button className="btn btn--primary btn--sm" onClick={handleConfirm} disabled={confirming}>
            {confirming ? 'Importiere…' : 'Bestätigen'}
          </button>
        </div>
      </div>

      <div className="qa-review-table">
        <div className="qa-review-thead">
          <span>Frage</span>
          <span>Antwort</span>
          <span>Tags</span>
          <span>Status</span>
        </div>

        {rows.map((row, i) => (
          <div key={i} className={`qa-review-row ${row.duplicates.length > 0 ? 'has-dupe' : ''} ${row.action === 'skip' ? 'is-skip' : ''}`}>
            <div className="qa-review-main">
              <div className="qa-review-q">{row.question}</div>
              <div className="qa-review-a">{row.answer.length > 200 ? row.answer.slice(0, 200) + '…' : row.answer}</div>
              <div className="qa-review-tags">
                <TagInput
                  tags={row.tags}
                  onChange={(tags) => setTags(i, tags)}
                  suggestedTags={row.suggested_tags}
                />
              </div>
              <div className="qa-review-status">
                {row.duplicates.length > 0 ? (
                  <button
                    className="qa-dupe-badge"
                    onClick={() => setExpanded(i, !row.expanded)}
                    title="Duplikate anzeigen"
                  >
                    ⚠ {row.duplicates.length} Duplikat{row.duplicates.length > 1 ? 'e' : ''}
                    <span className="qa-dupe-toggle">{row.expanded ? '▲' : '▼'}</span>
                  </button>
                ) : (
                  <span className="qa-new-badge">Neu</span>
                )}
              </div>
            </div>

            {row.duplicates.length > 0 && row.expanded && (
              <div className="qa-dupe-panel">
                <div className="qa-dupe-action-row">
                  <label className={row.action === 'import' ? 'active' : ''}>
                    <input type="radio" name={`action-${i}`} value="import" checked={row.action === 'import'} onChange={() => setAction(i, 'import')} />
                    Trotzdem importieren
                  </label>
                  <label className={row.action === 'skip' ? 'active' : ''}>
                    <input type="radio" name={`action-${i}`} value="skip" checked={row.action === 'skip'} onChange={() => setAction(i, 'skip')} />
                    Überspringen
                  </label>
                  <label className={row.action === 'replace' ? 'active' : ''}>
                    <input type="radio" name={`action-${i}`} value="replace" checked={row.action === 'replace'} onChange={() => setAction(i, 'replace', row.duplicates[0]?.id)} />
                    Bestehenden ersetzen
                  </label>
                </div>

                {row.duplicates.map((dupe) => (
                  <div key={dupe.id} className={`qa-dupe-entry ${row.action === 'replace' && row.replace_id === dupe.id ? 'selected' : ''}`}
                    onClick={() => row.action === 'replace' && setAction(i, 'replace', dupe.id)}
                  >
                    <div className="qa-dupe-score">{Math.round(dupe.score * 100)}%</div>
                    <div className="qa-dupe-content">
                      <div className="qa-dupe-q">{dupe.question}</div>
                      <div className="qa-dupe-a">{dupe.answer}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main Import view ───────────────────────────────────────────────────────────

export default function Import({ toast }: Props) {
  const [tab, setTab] = useState<'docs' | 'qa'>('docs')

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Import</h1>
          <p className="page-sub">Dokumente indexieren oder Q&A-Einträge als CSV importieren.</p>
        </div>
      </div>

      <div className="import-tabs">
        <button className={`import-tab ${tab === 'docs' ? 'active' : ''}`} onClick={() => setTab('docs')}>
          Dokumente
        </button>
        <button className={`import-tab ${tab === 'qa' ? 'active' : ''}`} onClick={() => setTab('qa')}>
          Q&A Bulk-Import
        </button>
      </div>

      {tab === 'docs' ? <DocImport toast={toast} /> : <QABulkImport toast={toast} />}
    </main>
  )
}
