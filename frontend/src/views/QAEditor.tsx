import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getEntry, updateQA, updateDoc, checkDuplicate, listTags, suggestTags } from '../api/client'
import type { AppSettings, DupeCandidate } from '../types'
import TagInput from '../components/TagInput'
import DupeWarning from '../components/DupeWarning'
import { useDebounce } from '../hooks/useDebounce'
import { useConfirm } from '../hooks/useConfirm'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
}

export default function QAEditor({ toast, settings }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { confirmDialog, ask } = useConfirm()

  const [entryType, setEntryType] = useState<'qa' | 'document'>('qa')
  const [title, setTitle] = useState('')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [content, setContent] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [dupes, setDupes] = useState<DupeCandidate[]>([])
  const [dupChecking, setDupChecking] = useState(false)
  const [hasChecked, setHasChecked] = useState(false)
  const [suggestedTagList, setSuggestedTagList] = useState<string[]>([])

  const debouncedQ = useDebounce(question, 600)
  const debouncedA = useDebounce(answer, 600)
  const debouncedContent = useDebounce(content, 600)

  useEffect(() => {
    listTags().then(({ tags }) => setAllTags(tags.map((t) => t.name))).catch(() => {})
  }, [])

  useEffect(() => {
    if (!id) return
    getEntry(Number(id))
      .then((e) => {
        setEntryType(e.entry_type)
        setTitle(e.title ?? '')
        setQuestion(e.question ?? '')
        setAnswer(e.answer ?? '')
        setContent(e.content ?? '')
        setTags(e.tags)
        setLoaded(true)
      })
      .catch(() => { toast('Eintrag nicht gefunden', 'error'); navigate(-1) })
  }, [id])

  // Dupe check for QA type
  useEffect(() => {
    if (entryType !== 'qa') return
    if (!debouncedQ.trim() && !debouncedA.trim()) {
      setDupes([])
      setHasChecked(false)
      setSuggestedTagList([])
      return
    }
    setDupChecking(true)
    checkDuplicate(debouncedQ, debouncedA)
      .then((results) => {
        setDupes(results.filter((d) => d.id !== Number(id)))
        setHasChecked(true)
      })
      .catch(() => {})
      .finally(() => setDupChecking(false))

    const text = [debouncedQ, debouncedA].filter(Boolean).join(' ')
    suggestTags(text).then(setSuggestedTagList).catch(() => {})
  }, [debouncedQ, debouncedA, id, entryType])

  // Tag suggestions for DOK type
  useEffect(() => {
    if (entryType !== 'document') return
    if (!debouncedContent.trim()) { setSuggestedTagList([]); return }
    suggestTags(debouncedContent).then(setSuggestedTagList).catch(() => {})
  }, [debouncedContent, entryType])

  const handleSave = async () => {
    setSaving(true)
    try {
      if (entryType === 'document') {
        if (!content.trim()) { toast('Inhalt darf nicht leer sein.', 'error'); return }
        const saved = await updateDoc(Number(id), { title: title.trim(), content: content.trim(), tags })
        toast('Dokument aktualisiert.', 'success')
        navigate(`/entries/${saved.id}`)
      } else {
        if (!question.trim()) { toast('Frage darf nicht leer sein.', 'error'); return }
        if (!answer.trim()) { toast('Antwort darf nicht leer sein.', 'error'); return }
        const saved = await updateQA(Number(id), { title: title.trim(), question: question.trim(), answer: answer.trim(), tags })
        toast('Eintrag aktualisiert.', 'success')
        navigate(`/entries/${saved.id}`)
      }
    } catch {
      toast('Speichern fehlgeschlagen.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = async () => {
    const dirty = entryType === 'document' ? content : (question || answer)
    if ((title || dirty || tags.length) && !await ask('Änderungen verwerfen?')) return
    navigate(`/entries/${id}`)
  }

  if (!loaded) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>

  const hasContent = debouncedQ.trim().length > 5 || debouncedA.trim().length > 5

  if (entryType === 'document') {
    return (
      <main className="pb-main">
        <div className="page-head">
          <div>
            <h1 className="page-h">Dokument bearbeiten</h1>
            <p className="page-sub">Änderungen werden nach dem Speichern neu eingebettet.</p>
          </div>
          <div className="action-row">
            <button className="btn btn--ghost" onClick={handleCancel}>Abbrechen</button>
            <button className="btn" onClick={handleSave} disabled={saving}>
              {saving ? 'Speichert…' : 'Speichern'}
            </button>
          </div>
        </div>

        <div className="editor">
          <div className="editor-main">
            <div className="field">
              <label>Titel <span className="field-hint">Kurzform – leer lassen für Fallback auf erste Zeile</span></label>
              <input
                className="txt title-input"
                placeholder="Dokumenttitel"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
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
          </div>

          <div className="editor-side">
            <div className="aside-card">
              <h4>Hinweis</h4>
              <p>Der Inhalt wird nach dem Speichern in Abschnitte aufgeteilt und neu eingebettet.</p>
              <p>Tags helfen bei der Filterung — z. B. IT, HR, Prozesse.</p>
            </div>
          </div>
        </div>
        {confirmDialog}
      </main>
    )
  }

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Eintrag bearbeiten</h1>
          <p className="page-sub">Änderungen werden nach dem Speichern neu eingebettet.</p>
        </div>
        <div className="action-row">
          <button className="btn btn--ghost" onClick={handleCancel}>Abbrechen</button>
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </div>

      <div className="editor">
        <div className="editor-main">
          <div className="field">
            <label>Titel <span className="field-hint">Kurzform – leer lassen für Fallback auf die Frage</span></label>
            <input
              className="txt title-input"
              placeholder="SSO-Passwort zurücksetzen"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="field">
            <label>Frage</label>
            <input
              className="txt title-input"
              placeholder="Wie resete ich mein SSO-Passwort?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Antwort</label>
            <textarea
              className="txt body-input"
              placeholder="Schritt-für-Schritt-Antwort. Plain-Text reicht."
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </div>

          <div className="field">
            <label>Tags</label>
            <TagInput tags={tags} onChange={setTags} suggestions={allTags} suggestedTags={suggestedTagList} />
          </div>

          <DupeWarning candidates={dupes} checking={dupChecking} hasContent={hasContent && hasChecked} />
        </div>

        <div className="editor-side">
          <div className="aside-card">
            <h4>Tipps</h4>
            <p>Verwende eine klare, konkrete Frage. Die Suche findet auch ähnlich formulierte Anfragen.</p>
            <p>Tags helfen bei der Filterung — z. B. IT, HR, Prozesse.</p>
          </div>
        </div>
      </div>
      {confirmDialog}
    </main>
  )
}
