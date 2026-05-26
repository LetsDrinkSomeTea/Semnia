import { useNavigate } from 'react-router-dom'
import type { DupeCandidate } from '../types'

interface Props {
  candidates: DupeCandidate[]
  checking: boolean
}

export default function DupeWarning({ candidates, checking }: Props) {
  const navigate = useNavigate()

  if (checking) {
    return (
      <div className="dup-warn">
        <h5>⟳ Prüfe Duplikate…</h5>
      </div>
    )
  }

  if (!candidates.length) return null

  return (
    <div className="dup-warn">
      <h5>⚠ Ähnliche Einträge gefunden</h5>
      <p className="hint">
        Diese Einträge haben einen hohen Ähnlichkeitswert. Du kannst trotzdem speichern.
      </p>
      {candidates.map((c) => (
        <div
          key={c.id}
          className="item"
          onClick={() => navigate(`/entries/${c.id}`)}
          role="button"
        >
          <div className="q">{c.title}</div>
          <div className="sim">Ähnlichkeit: {Math.round(c.score * 100)}%</div>
        </div>
      ))}
    </div>
  )
}
