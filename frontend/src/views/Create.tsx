import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  createQA, createDoc, checkDuplicate, listTags, suggestTags,
  uploadFile, getImportStatus, updateImportTags, listImports,
  parseQACsvStream, confirmQAImport, getEntry,
} from '../api/client'
import type { QABulkRow, QABulkRowEvent, QABulkAction } from '../api/client'
import type { AppSettings, DupeCandidate, Entry } from '../types'
import TagInput from '../components/TagInput'
import DupeWarning from '../components/DupeWarning'
import QABulkImportDetail from '../components/QABulkImportDetail'
import { useDebounce } from '../hooks/useDebounce'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
}

interface UploadState {
  file: string
  entry_id: number | null
  chunk_count: number
  embedded_count: number
  done: boolean
  error: string | null
  tags: string[]
  created_at: string | null
}

export interface ReviewRow extends QABulkRow {
  action: 'import' | 'skip' | 'replace'
  replace_id?: number
  expanded: boolean
  title: string
  dupeEntry?: Entry | null
  dupeLoading?: boolean
}

// ── FAQ Write Form ─────────────────────────────────────────────────────────────

function FAQWriteForm({ toast, settings }: Props) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [dupes, setDupes] = useState<DupeCandidate[]>([])
  const [dupChecking, setDupChecking] = useState(false)
  const [hasChecked, setHasChecked] = useState(false)
  const [suggestedTagList, setSuggestedTagList] = useState<string[]>([])

  const debouncedQ = useDebounce(question, 600)
  const debouncedA = useDebounce(answer, 600)

  useEffect(() => {
    listTags().then(({ tags }) => setAllTags(tags.map((t) => t.name))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!debouncedQ.trim() && !debouncedA.trim()) {
      setDupes([]); setHasChecked(false); setSuggestedTagList([]); return
    }
    setDupChecking(true)
    checkDuplicate(debouncedQ, debouncedA)
      .then((results) => { setDupes(results); setHasChecked(true) })
      .catch(() => {})
      .finally(() => setDupChecking(false))
    const text = [debouncedQ, debouncedA].filter(Boolean).join(' ')
    suggestTags(text).then(setSuggestedTagList).catch(() => {})
  }, [debouncedQ, debouncedA])

  const handleSave = async () => {
    if (!question.trim()) { toast('Frage darf nicht leer sein.', 'error'); return }
    if (!answer.trim()) { toast('Antwort darf nicht leer sein.', 'error'); return }
    setSaving(true)
    try {
      const saved = await createQA({ title: title.trim(), question: question.trim(), answer: answer.trim(), tags })
      toast('Eintrag angelegt.', 'success')
      navigate(`/entries/${saved.id}`)
    } catch { toast('Speichern fehlgeschlagen.', 'error') }
    finally { setSaving(false) }
  }

  const hasContent = debouncedQ.trim().length > 5 || debouncedA.trim().length > 5

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="field">
          <label>Titel <span className="field-hint">Kurzform – leer lassen für Fallback auf die Frage</span></label>
          <input className="txt title-input" placeholder="SSO-Passwort zurücksetzen" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Frage</label>
          <input className="txt title-input" placeholder="Wie resete ich mein SSO-Passwort?" value={question} onChange={(e) => setQuestion(e.target.value)} />
        </div>
        <div className="field">
          <label>Antwort</label>
          <textarea className="txt body-input" placeholder="Schritt-für-Schritt-Antwort. Plain-Text reicht." value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </div>
        <div className="field">
          <label>Tags</label>
          <TagInput tags={tags} onChange={setTags} suggestions={allTags} suggestedTags={suggestedTagList} />
        </div>
        <DupeWarning candidates={dupes} checking={dupChecking} hasContent={hasContent && hasChecked} />
        <div className="action-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleSave} disabled={saving}>{saving ? 'Speichert…' : 'Speichern'}</button>
        </div>
      </div>
      <div className="editor-side">
        <div className="aside-card">
          <h4>Tipps</h4>
          <p>Verwende eine klare, konkrete Frage. Die Suche findet auch ähnlich formulierte Anfragen.</p>
          <p>Tags helfen bei der Filterung — z. B. IT, HR, Prozesse.</p>
        </div>
      </div>
    </div>
  )
}

// ── DOK Write Form ─────────────────────────────────────────────────────────────

function DOKWriteForm({ toast }: Props) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [suggestedTagList, setSuggestedTagList] = useState<string[]>([])

  const debouncedContent = useDebounce(content, 600)

  useEffect(() => {
    listTags().then(({ tags }) => setAllTags(tags.map((t) => t.name))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!debouncedContent.trim()) { setSuggestedTagList([]); return }
    suggestTags(debouncedContent).then(setSuggestedTagList).catch(() => {})
  }, [debouncedContent])

  const handleSave = async () => {
    if (!content.trim()) { toast('Inhalt darf nicht leer sein.', 'error'); return }
    setSaving(true)
    try {
      const saved = await createDoc({ title: title.trim(), content: content.trim(), tags })
      toast('Dokument angelegt.', 'success')
      navigate(`/entries/${saved.id}`)
    } catch { toast('Speichern fehlgeschlagen.', 'error') }
    finally { setSaving(false) }
  }

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="field">
          <label>Titel <span className="field-hint">Leer lassen für Fallback auf erste Zeile</span></label>
          <input className="txt title-input" placeholder="Dokumenttitel" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Inhalt</label>
          <textarea
            className="txt body-input"
            placeholder="Dokumentinhalt – Plain-Text oder Markdown."
            value={content}
            onChange={(e) => setContent(e.target.value)}
            style={{ minHeight: 360 }}
          />
        </div>
        <div className="field">
          <label>Tags</label>
          <TagInput tags={tags} onChange={setTags} suggestions={allTags} suggestedTags={suggestedTagList} />
        </div>
        <div className="action-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" onClick={handleSave} disabled={saving}>{saving ? 'Speichert…' : 'Speichern'}</button>
        </div>
      </div>
      <div className="editor-side">
        <div className="aside-card">
          <h4>Hinweis</h4>
          <p>Der Inhalt wird nach dem Speichern in Abschnitte aufgeteilt und eingebettet.</p>
          <p>Tags helfen bei der Filterung — z. B. IT, HR, Prozesse.</p>
        </div>
      </div>
    </div>
  )
}

// ── Unified Import Section ─────────────────────────────────────────────────────

function UnifiedImportSection({ toast }: { toast: Props['toast'] }) {
  const navigate = useNavigate()
  const FIVE_MIN = 5 * 60 * 1000

  // Doc upload state
  const [uploads, setUploads] = useState<UploadState[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // CSV review state
  const [csvMode, setCsvMode] = useState(false)
  const [csvParsing, setCsvParsing] = useState(false)
  const [parseComplete, setParseComplete] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [rows, setRows] = useState<ReviewRow[]>([])
  const [selectedRowIndex, setSelectedRowIndex] = useState(0)
  const abortRef = useRef<AbortController | null>(null)

  // Dropzone state
  const [over, setOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listTags().then(({ tags }) => setAllTags(tags.map((t) => t.name))).catch(() => {})
    listImports(1).then((resp) => {
      const now = Date.now()
      const relevant = resp.items.filter((item) => {
        const done = item.chunk_count > 0 && item.embedded_count >= item.chunk_count
        const recent = item.created_at ? (now - new Date(item.created_at).getTime() < FIVE_MIN) : false
        return !done || recent
      })
      if (relevant.length > 0) {
        setUploads(relevant.map((item) => ({
          file: item.source_filename || item.title || String(item.id),
          entry_id: item.id,
          chunk_count: item.chunk_count,
          embedded_count: item.embedded_count,
          done: item.chunk_count > 0 && item.embedded_count >= item.chunk_count,
          error: null,
          tags: item.tags,
          created_at: item.created_at,
        })))
      }
    }).catch(() => {})
  }, [])

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
          prev.map((p) => p.entry_id === u.entry_id ? { ...p, embedded_count: s.embedded_count, done: s.done } : p)
        )
      }
    }, 2000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [uploads])

  const handleDocFile = async (file: File) => {
    // Falls der Pfad vorhanden ist (z.B. aus Ordner-Upload), zeigen wir ihn an.
    const displayPath = (file as any).webkitRelativePath || file.name
    const state: UploadState = {
      file: displayPath, entry_id: null, chunk_count: 0, embedded_count: 0,
      done: false, error: null, tags: [], created_at: new Date().toISOString(),
    }
    setUploads((prev) => [...prev, state])
    try {
      const result = await uploadFile(file)
      setUploads((prev) =>
        prev.map((u) => u.file === displayPath && u.entry_id === null
          ? { ...u, entry_id: result.entry_id, chunk_count: result.chunk_count }
          : u)
      )
      toast(`"${result.title}" importiert (${result.chunk_count} Abschnitte)`, 'success')
    } catch (e) {
      setUploads((prev) =>
        prev.map((u) => u.file === displayPath && u.entry_id === null
          ? { ...u, done: true, error: (e as Error).message }
          : u)
      )
      toast(`Fehler bei ${file.name}: ${(e as Error).message}`, 'error')
    }
  }

  const parseCsvAsync = (file: File, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      parseQACsvStream(
        file,
        (row: QABulkRowEvent) => {
          setRows((prev) => [...prev, {
            ...row,
            action: row.duplicates.length > 0 ? 'skip' : 'import',
            replace_id: row.duplicates[0]?.id,
            expanded: row.duplicates.length > 0,
            dupeEntry: undefined,
            dupeLoading: false,
          }])
        },
        () => resolve(),
        (msg) => reject(new Error(msg)),
        signal,
      )
    })

  const handleFiles = async (files: File[] | FileList) => {
    const fileArray = Array.from(files)
    const csvFiles = fileArray.filter((f) => f.name.split('.').pop()?.toLowerCase() === 'csv')
    const docFiles = fileArray.filter((f) => ['md', 'pdf', 'docx', 'doc'].includes(f.name.split('.').pop()?.toLowerCase() ?? ''))
    const unsupported = fileArray.filter((f) => !['csv', 'md', 'pdf', 'docx', 'doc'].includes(f.name.split('.').pop()?.toLowerCase() ?? ''))

    for (const f of unsupported) toast(`Format nicht unterstützt: .${f.name.split('.').pop()}`, 'error')
    for (const file of docFiles) handleDocFile(file)

    if (csvFiles.length > 0) {
      setCsvMode(true)
      setParseComplete(false)
      setCsvParsing(true)
      const ctrl = new AbortController()
      abortRef.current = ctrl
      for (const file of csvFiles) {
        if (ctrl.signal.aborted) break
        try {
          await parseCsvAsync(file, ctrl.signal)
        } catch (e) {
          if ((e as Error).name === 'AbortError') break
          toast(`Fehler in ${file.name}: ${(e as Error).message}`, 'error')
        }
      }
      if (!ctrl.signal.aborted) {
        setCsvParsing(false)
        setParseComplete(true)
        abortRef.current = null
      }
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setOver(false)
    const items = e.dataTransfer.items
    const allFiles: File[] = []

    const readEntry = async (entry: any) => {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve) => entry.file(resolve))
        allFiles.push(file)
      } else if (entry.isDirectory) {
        const reader = entry.createReader()
        const entries = await new Promise<any[]>((resolve) => {
          reader.readEntries(resolve)
        })
        for (const child of entries) {
          await readEntry(child)
        }
      }
    }

    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.webkitGetAsEntry) {
          const entry = item.webkitGetAsEntry()
          if (entry) await readEntry(entry)
        } else if (item.kind === 'file') {
          const file = item.getAsFile()
          if (file) allFiles.push(file)
        }
      }
    } else if (e.dataTransfer.files) {
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        allFiles.push(e.dataTransfer.files[i])
      }
    }

    if (allFiles.length > 0) {
      handleFiles(allFiles)
    }
  }

  const handleTagChange = async (entry_id: number, newTags: string[]) => {
    setUploads((prev) => prev.map((u) => u.entry_id === entry_id ? { ...u, tags: newTags } : u))
    await updateImportTags(entry_id, newTags).catch(() => {})
  }

  const resetCsv = () => {
    abortRef.current?.abort(); abortRef.current = null
    setRows([]); setSelectedRowIndex(0); setCsvParsing(false); setParseComplete(false); setCsvMode(false)
  }

  const setAction = (i: number, action: ReviewRow['action'], replaceId?: number) =>
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, action, replace_id: replaceId ?? r.replace_id } : r))

  const setRowTags = (i: number, tags: string[]) =>
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, tags } : r))

  const setRowTitle = (i: number, t: string) =>
    setRows((prev) => prev.map((r, idx) => idx === i ? { ...r, title: t } : r))

  const setExpanded = (i: number, expanded: boolean) => {
    setRows((prev) => prev.map((r, idx) => {
      if (idx !== i) return r
      const next = { ...r, expanded }
      if (expanded && r.duplicates.length > 0 && r.dupeEntry === undefined && !r.dupeLoading) {
        next.dupeLoading = true
        getEntry(r.duplicates[0].id)
          .then((e) => setRows((p) => p.map((x, xi) => xi === i ? { ...x, dupeEntry: e, dupeLoading: false } : x)))
          .catch(() => setRows((p) => p.map((x, xi) => xi === i ? { ...x, dupeEntry: null, dupeLoading: false } : x)))
      }
      return next
    }))
  }


  const handleConfirm = async () => {
    if (!parseComplete || rows.length === 0) return
    setConfirming(true)
    const items: QABulkAction[] = rows.map((r) => ({
      title: r.title, question: r.question, answer: r.answer, tags: r.tags,
      action: r.action, replace_id: r.action === 'replace' ? r.replace_id : undefined,
    }))
    try {
      const result = await confirmQAImport(items)
      toast(`${result.imported} importiert, ${result.replaced} ersetzt, ${result.skipped} übersprungen`, 'success')
      resetCsv()
    } catch (e) {
      toast(`Fehler: ${(e as Error).message}`, 'error')
    } finally { setConfirming(false) }
  }

  const ext = (filename: string) => filename.split('.').pop()?.toUpperCase() ?? '?'

  const newCount = rows.filter((r) => r.action === 'import').length
  const skipCount = rows.filter((r) => r.action === 'skip').length
  const replaceCount = rows.filter((r) => r.action === 'replace').length
  const dupeCount = rows.filter((r) => r.duplicates.length > 0).length

  return (
    <>
      {/* Unified dropzone or CSV review */}
      {!csvMode ? (
        <div
          className={`import-drop ${over ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true) }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
        >
          <div className="big-ic">+</div>
          <h3>Dateien oder Ordner hierher ziehen</h3>
          <p style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
            oder <button className="btn btn--ghost btn--sm" onClick={() => fileInputRef.current?.click()}>Dateien</button>{' '}
            <button className="btn btn--ghost btn--sm" onClick={() => folderInputRef.current?.click()}>Ordner</button> auswählen
          </p>
          <p style={{ fontSize: 11, opacity: 0.6 }}>CSV → FAQ-Einträge &nbsp;·&nbsp; PDF / DOCX / MD → Dokument</p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.md,.pdf,.docx,.doc"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
          <input
            ref={folderInputRef}
            type="file"
            // @ts-ignore: webkitdirectory is a non-standard attribute but widely supported
            webkitdirectory="true"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => e.target.files && handleFiles(e.target.files)}
          />
        </div>
      ) : (
        <div className="qa-review">
          <div className="qa-review-bar">
            <div className="qa-review-stats">
              {csvParsing && (
                <span className="qa-parse-progress">
                  <span className="qa-parse-spinner">⟳</span>
                  {rows.length} analysiert…
                </span>
              )}
              {rows.length > 0 && <span>{parseComplete ? `${rows.length} Einträge` : ''}</span>}
              {dupeCount > 0 && <span className="qa-stat-warn">{dupeCount} Duplikate</span>}
              {parseComplete && <span className="qa-stat-new">{newCount} importieren</span>}
              {replaceCount > 0 && <span className="qa-stat-replace">{replaceCount} ersetzen</span>}
              {skipCount > 0 && <span className="qa-stat-skip">{skipCount} überspringen</span>}
            </div>
            <div className="qa-review-actions">
              <button className="btn btn--ghost btn--sm" onClick={resetCsv}>Abbrechen</button>
              <button className="btn btn--primary btn--sm" onClick={handleConfirm} disabled={!parseComplete || confirming || rows.length === 0}>
                {confirming ? 'Importiere…' : 'Bestätigen'}
              </button>
            </div>
          </div>

          <div className="qa-split-layout">
            <div className="qa-split-sidebar">
              {rows.map((row, i) => (
                <div 
                  key={i}
                  className={`qa-split-item ${i === selectedRowIndex ? 'active' : ''} ${row.action === 'skip' ? 'skipped' : ''} ${row.duplicates.length > 0 ? 'conflict' : 'new'}`}
                  onClick={() => {
                    setSelectedRowIndex(i)
                    if (row.duplicates.length > 0 && row.dupeEntry === undefined && !row.dupeLoading) {
                      setExpanded(i, true)
                    }
                  }}
                >
                  <div className="qa-split-item-q">{row.question || 'Leere Frage'}</div>
                  <div className="qa-split-item-status">
                    {row.action === 'skip' ? 'Übersprungen' : row.action === 'replace' ? 'Ersetzen' : row.duplicates.length > 0 ? `${row.duplicates.length} Konflikte` : 'Neu'}
                  </div>
                </div>
              ))}
            </div>
            
            <div className="qa-split-detail">
              {rows.length > 0 && rows[selectedRowIndex] && (
                <QABulkImportDetail
                  row={rows[selectedRowIndex] as any}
                  index={selectedRowIndex}
                  setRowTitle={setRowTitle}
                  setTags={setRowTags}
                  setExpanded={setExpanded}
                  setAction={setAction}
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Import list – always visible */}
      {uploads.length > 0 && (
        <>
          <p className="section-h" style={{ marginTop: 20 }}>Aktuelle Importe</p>
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
                  {u.entry_id && !u.error && (
                    <div style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 12, paddingTop: 4 }}>
                      <div style={{ flex: 1 }}>
                        <TagInput tags={u.tags} onChange={(newTags) => handleTagChange(u.entry_id!, newTags)} suggestions={allTags} />
                      </div>
                      {u.done && (
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/entries/${u.entry_id}`)}>Anzeigen</button>
                          <button className="btn btn--ghost btn--sm" onClick={() => navigate(`/editor/${u.entry_id}`)}>Bearbeiten</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </>
  )
}

// ── Main Create View ───────────────────────────────────────────────────────────

type Tab = 'faq' | 'dok' | 'import'

export default function Create({ toast, settings }: Props) {
  const [tab, setTab] = useState<Tab>('faq')

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Erstellen</h1>
          <p className="page-sub">FAQ-Einträge schreiben, Dokumente verfassen oder Dateien importieren.</p>
        </div>
      </div>

      <div className="import-tabs">
        <button className={`import-tab ${tab === 'faq' ? 'active' : ''}`} onClick={() => setTab('faq')}>FAQ schreiben</button>
        <button className={`import-tab ${tab === 'dok' ? 'active' : ''}`} onClick={() => setTab('dok')}>Dokument schreiben</button>
        <button className={`import-tab ${tab === 'import' ? 'active' : ''}`} onClick={() => setTab('import')}>Importieren</button>
      </div>

      {tab === 'faq' && <FAQWriteForm toast={toast} settings={settings} />}
      {tab === 'dok' && <DOKWriteForm toast={toast} settings={settings} />}
      {tab === 'import' && <UnifiedImportSection toast={toast} />}
    </main>
  )
}
