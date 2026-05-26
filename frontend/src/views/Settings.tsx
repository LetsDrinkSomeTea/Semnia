import { useState } from 'react'
import { updateSettings, reindex, resetData } from '../api/client'
import type { AppSettings } from '../types'
import { useSettings } from '../hooks/useSettings'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

export default function Settings({ toast }: Props) {
  const { settings, loading, refresh } = useSettings()
  const [local, setLocal] = useState<Partial<AppSettings>>({})
  const [reindexing, setReindexing] = useState(false)
  const [resetting, setResetting] = useState(false)

  const val = <K extends keyof AppSettings>(key: K): AppSettings[K] =>
    (local[key] ?? settings[key]) as AppSettings[K]

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setLocal((l) => ({ ...l, [key]: value }))

  const save = async () => {
    try {
      await updateSettings(local)
      await refresh()
      setLocal({})
      toast('Einstellungen gespeichert.', 'success')
    } catch {
      toast('Speichern fehlgeschlagen.', 'error')
    }
  }

  const handleReindex = async () => {
    setReindexing(true)
    try {
      const r = await reindex()
      const reader = r.body?.getReader()
      if (reader) {
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      }
      toast('Reindex abgeschlossen.', 'success')
    } catch {
      toast('Reindex fehlgeschlagen.', 'error')
    } finally {
      setReindexing(false)
    }
  }

  const handleReset = async () => {
    if (!confirm('Alle Daten löschen und Seed-Daten laden? Dies kann nicht rückgängig gemacht werden.'))
      return
    setResetting(true)
    try {
      const r = await resetData()
      toast(`Zurückgesetzt. ${r.seed_count} Seed-Einträge geladen.`, 'success')
    } catch {
      toast('Reset fehlgeschlagen.', 'error')
    } finally {
      setResetting(false)
    }
  }

  const Slider = ({
    label,
    envVar,
    settKey,
    description,
  }: {
    label: string
    envVar: string
    settKey: 'search_threshold' | 'dupe_threshold' | 'hybrid_alpha'
    description: string
  }) => {
    const v = val(settKey) as number
    const pct = `${Math.round(v * 100)}%`
    return (
      <div className="setting">
        <h6>{label} <code className="env-tag">{envVar}</code></h6>
        <div className="val">{v.toFixed(2)}</div>
        <div className="threshold-slider" style={{ '--p': pct } as React.CSSProperties}>
          <div
            className="track"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              set(settKey, Math.round(((e.clientX - rect.left) / rect.width) * 100) / 100 as AppSettings[typeof settKey])
            }}
          >
            <div className="fill" />
            <div className="knob" />
          </div>
          <div className="label">
            <span>0</span>
            <span className="v">{pct}</span>
            <span>1</span>
          </div>
        </div>
        <small>{description}</small>
      </div>
    )
  }

  if (loading) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Einstellungen</h1>
          <p className="page-sub">Laufzeitkonfiguration. Env-vars (siehe <code>.env.example</code>) werden beim Neustart angewendet.</p>
        </div>
        <div className="action-row">
          {Object.keys(local).length > 0 && (
            <button className="btn" onClick={save}>Speichern</button>
          )}
        </div>
      </div>

      <div className="settings-wrap">
        <h3>Suche</h3>
        <div className="settings-grid">
          <Slider
            label="Ähnlichkeitsschwelle"
            envVar="SEARCH_THRESHOLD"
            settKey="search_threshold"
            description="Minimum-Score für Suchergebnisse (0 = alles, 1 = nur exakt)"
          />
          <Slider
            label="Duplikat-Schwelle"
            envVar="DUPE_THRESHOLD"
            settKey="dupe_threshold"
            description="Ab wann ein Eintrag im Editor als Duplikat gewarnt wird"
          />
          <Slider
            label="Hybrid-Alpha (α)"
            envVar="HYBRID_ALPHA"
            settKey="hybrid_alpha"
            description="Gewichtung Semantik vs. Volltext (1 = rein semantisch, 0 = rein Volltext)"
          />
          <div className="setting">
            <h6>Top-K Ergebnisse <code className="env-tag">TOP_K</code></h6>
            <div className="stepper">
              <button onClick={() => set('top_k', Math.max(1, (val('top_k') as number) - 1))}>−</button>
              <span className="v">{val('top_k')}</span>
              <button onClick={() => set('top_k', Math.min(50, (val('top_k') as number) + 1))}>+</button>
            </div>
            <small>Maximale Anzahl Suchergebnisse</small>
          </div>
          <div className="setting">
            <h6>Chunk-Größe (Zeichen) <code className="env-tag">CHUNK_SIZE</code></h6>
            <div className="stepper">
              <button onClick={() => set('chunk_size', Math.max(200, (val('chunk_size') as number) - 100))}>−</button>
              <span className="v">{val('chunk_size')}</span>
              <button onClick={() => set('chunk_size', Math.min(5000, (val('chunk_size') as number) + 100))}>+</button>
            </div>
            <small>Maximale Chunk-Länge bei Antworten und Dokumenten (nach Reindex aktiv)</small>
          </div>
          <div className="setting">
            <h6>Chunk-Überlappung (Zeichen) <code className="env-tag">CHUNK_OVERLAP</code></h6>
            <div className="stepper">
              <button onClick={() => set('chunk_overlap', Math.max(0, (val('chunk_overlap') as number) - 50))}>−</button>
              <span className="v">{val('chunk_overlap')}</span>
              <button onClick={() => set('chunk_overlap', Math.min(1000, (val('chunk_overlap') as number) + 50))}>+</button>
            </div>
            <small>Überlappung zwischen aufeinanderfolgenden Chunks (nach Reindex aktiv)</small>
          </div>
        </div>

        <h3>Ollama <span style={{ fontWeight: 400, fontSize: 13, color: 'var(--primary--500)' }}>(KI-Zusammenfassung)</span></h3>
        <div className="settings-grid">
          <div className="setting">
            <h6>Ollama URL <code className="env-tag">OLLAMA_URL</code></h6>
            <input
              className="txt"
              value={val('ollama_url') as string}
              onChange={(e) => set('ollama_url', e.target.value)}
              placeholder="http://ollama:11434"
            />
            <small>Leer lassen, wenn Ollama nicht verwendet wird</small>
          </div>
          <div className="setting">
            <h6>Modell <code className="env-tag">OLLAMA_MODEL</code></h6>
            <input
              className="txt"
              value={val('ollama_model') as string}
              onChange={(e) => set('ollama_model', e.target.value)}
              placeholder="llama3.2:3b"
            />
            <small>Muss auf dem Ollama-Server verfügbar sein</small>
          </div>
        </div>

        <h3>System</h3>
        <div className="settings-grid">
          <div className="setting">
            <h6>Embeddings neu berechnen</h6>
            <p style={{ fontSize: 13, color: 'var(--primary--900)', marginBottom: 12 }}>
              Alle Einträge werden neu eingebettet. Dauert einige Minuten.
            </p>
            <button className="btn btn--ghost btn--sm" onClick={handleReindex} disabled={reindexing}>
              {reindexing ? 'Läuft…' : 'Reindex starten'}
            </button>
          </div>
          <div className="setting">
            <h6>Auf Seed-Daten zurücksetzen</h6>
            <p style={{ fontSize: 13, color: 'var(--primary--900)', marginBottom: 12 }}>
              Alle Einträge werden gelöscht. Beispieldaten werden geladen.
            </p>
            <button
              className="btn btn--sm"
              onClick={handleReset}
              disabled={resetting}
              style={{ background: 'var(--base--action)' }}
            >
              {resetting ? 'Läuft…' : 'Zurücksetzen'}
            </button>
          </div>
        </div>
      </div>
    </main>
  )
}
