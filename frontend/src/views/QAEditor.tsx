import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getEntry, createQA, updateQA, checkDuplicate, listTags } from '../api/client'
import type { AppSettings, DupeCandidate } from '../types'
import TagInput from '../components/TagInput'
import DupeWarning from '../components/DupeWarning'
import { useDebounce } from '../hooks/useDebounce'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
  settings: AppSettings
}

export default function QAEditor({ toast, settings }: Props) {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const isNew = !id || id === 'new'

  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [allTags, setAllTags] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [loaded, setLoaded] = useState(isNew)
  const [dupes, setDupes] = useState<DupeCandidate[]>([])
  const [dupChecking, setDupChecking] = useState(false)

  const debouncedQ = useDebounce(question, 500)
  const debouncedA = useDebounce(answer, 500)

  useEffect(() => {
    listTags().then((ts) => setAllTags(ts.map((t) => t.name))).catch(() => {})
  }, [])

  useEffect(() => {
    if (isNew || !id) return
    getEntry(Number(id))
      .then((e) => {
        setQuestion(e.question ?? '')
        setAnswer(e.answer ?? '')
        setTags(e.tags)
        setLoaded(true)
      })
      .catch(() => { toast('Eintrag nicht gefunden', 'error'); navigate('/browse') })
  }, [id])

  // Live duplicate check
  useEffect(() => {
    if (!debouncedQ.trim() && !debouncedA.trim()) { setDupes([]); return }
    setDupChecking(true)
    checkDuplicate(debouncedQ, debouncedA)
      .then((results) => {
        // Exclude self
        setDupes(results.filter((d) => d.id !== Number(id)))
      })
      .catch(() => {})
      .finally(() => setDupChecking(false))
  }, [debouncedQ, debouncedA, id])

  const handleSave = async () => {
    if (!question.trim()) { toast('Frage darf nicht leer sein.', 'error'); return }
    if (!answer.trim()) { toast('Antwort darf nicht leer sein.', 'error'); return }
    setSaving(true)
    try {
      let saved
      if (isNew) {
        saved = await createQA({ question: question.trim(), answer: answer.trim(), tags })
        toast('Eintrag angelegt.', 'success')
      } else {
        saved = await updateQA(Number(id), {
          question: question.trim(),
          answer: answer.trim(),
          tags,
        })
        toast('Eintrag aktualisiert.', 'success')
      }
      navigate(`/entries/${saved.id}`)
    } catch (e) {
      toast('Speichern fehlgeschlagen.', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleCancel = () => {
    if ((question || answer || tags.length) && !confirm('Änderungen verwerfen?')) return
    if (!isNew && id) navigate(`/entries/${id}`)
    else navigate('/browse')
  }

  if (!loaded) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">{isNew ? 'Neuer Eintrag' : 'Eintrag bearbeiten'}</h1>
          <p className="page-sub">
            {isNew
              ? 'Frage und Antwort eingeben — das System prüft live, ob ähnliche Einträge bestehen.'
              : 'Änderungen werden nach dem Speichern neu eingebettet.'}
          </p>
        </div>
        <div className="action-row">
          <button className="btn btn--ghost" onClick={handleCancel}>
            Abbrechen
          </button>
          <button className="btn" onClick={handleSave} disabled={saving}>
            {saving ? 'Speichert…' : 'Speichern'}
          </button>
        </div>
      </div>

      <div className="editor">
        <div className="editor-main">
          <div className="field">
            <label>Frage</label>
            <input
              className="txt title-input"
              placeholder="Wie resete ich mein SSO-Passwort?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              autoFocus={isNew}
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
            <TagInput tags={tags} onChange={setTags} suggestions={allTags} />
          </div>
        </div>

        <div className="editor-side">
          <DupeWarning candidates={dupes} checking={dupChecking} />
          <div className="aside-card">
            <h4>Tipps</h4>
            <p>Verwende eine klare, konkrete Frage. Die Suche findet auch ähnlich formulierte Anfragen.</p>
            <p>Tags helfen bei der Filterung — z. B. IT, HR, Prozesse.</p>
          </div>
        </div>
      </div>
    </main>
  )
}
