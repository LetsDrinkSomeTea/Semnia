import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { uploadFile, listImports, getImportStatus, deleteImport } from '../api/client'
import type { ImportItem } from '../types'

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

export default function Import({ toast }: Props) {
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

  useEffect(() => {
    loadImports()
  }, [])

  // Poll embedding progress for unfinished uploads
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
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [uploads, loadImports])

  const handleFiles = async (files: FileList) => {
    for (const file of Array.from(files)) {
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (!['md', 'pdf', 'docx', 'doc'].includes(ext ?? '')) {
        toast(`Format nicht unterstützt: .${ext}`, 'error')
        continue
      }

      const state: UploadState = {
        file: file.name,
        entry_id: null,
        chunk_count: 0,
        embedded_count: 0,
        done: false,
        error: null,
      }
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
    e.preventDefault()
    setOver(false)
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
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Import</h1>
          <p className="page-sub">
            Lade MD-, PDF- oder DOCX-Dateien hoch. Dokumente werden automatisch indexiert und
            durchsuchbar gemacht.
          </p>
        </div>
      </div>

      {/* Drop zone */}
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

      {/* Current session uploads */}
      {uploads.length > 0 && (
        <>
          <p className="section-h">Aktueller Upload</p>
          <div className="import-queue">
            {uploads.map((u, i) => {
              const pct =
                u.chunk_count > 0 ? Math.round((u.embedded_count / u.chunk_count) * 100) : 0
              return (
                <div className="queue-row" key={i}>
                  <span className="ext">{ext(u.file)}</span>
                  <span className="name">{u.file}</span>
                  <div className="bar">
                    <div
                      className="fill"
                      style={{
                        width: u.error ? '100%' : u.chunk_count === 0 ? '10%' : `${pct}%`,
                        background: u.error ? 'var(--base--action)' : undefined,
                      }}
                    />
                  </div>
                  <span className={`stat ${u.done && !u.error ? 'done' : ''}`}>
                    {u.error
                      ? 'Fehler'
                      : u.done
                      ? 'Fertig'
                      : u.chunk_count === 0
                      ? 'Lädt…'
                      : `${u.embedded_count}/${u.chunk_count}`}
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}

      {/* All imported documents */}
      {loading ? (
        <div className="empty"><p>Lädt…</p></div>
      ) : imports.length > 0 ? (
        <>
          <p className="section-h">Importierte Dokumente</p>
          <div className="import-queue">
            {imports.map((item) => {
              const pct =
                item.chunk_count > 0
                  ? Math.round((item.embedded_count / item.chunk_count) * 100)
                  : 100
              return (
                <div className="queue-row" key={item.id} style={{ gridTemplateColumns: '52px 1fr 140px 100px 80px' }}>
                  <span className="ext">{ext(item.source_filename)}</span>
                  <span
                    className="name"
                    style={{ cursor: 'pointer', color: 'var(--base--action)' }}
                    onClick={() => navigate(`/entries/${item.id}`)}
                  >
                    {item.title}
                  </span>
                  <div className="bar">
                    <div className="fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className={`stat ${item.embedded_count >= item.chunk_count ? 'done' : ''}`}>
                    {item.embedded_count >= item.chunk_count
                      ? 'Indexiert'
                      : `${item.embedded_count}/${item.chunk_count}`}
                  </span>
                  <div className="queue-actions">
                    <button
                      className="btn btn--ghost btn--sm"
                      onClick={() => onDelete(item.id)}
                    >
                      ×
                    </button>
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
    </main>
  )
}
