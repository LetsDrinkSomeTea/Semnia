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
      // consume SSE stream
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
    settKey,
    description,
  }: {
    label: string
    settKey: 'search_threshold' | 'dupe_threshold' | 'hybrid_alpha'
    description: string
  }) => {
    const v = val(settKey) as number
    const pct = `${Math.round(v * 100)}%`
    return (
      <div className="setting">
        <h6>{label}</h6>
        <div className="val">{v.toFixed(2)}</div>
        <div
          className="threshold-slider"
          style={{ '--p': pct } as React.CSSProperties}
        >
          <div
            className="track"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const newVal = Math.round(((e.clientX - rect.left) / rect.width) * 100) / 100
              set(settKey, newVal as AppSettings[typeof settKey])
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
          <p className="page-sub">Suche, Schwellenwerte und Systemverwaltung.</p>
        </div>
        <div className="action-row">
          {Object.keys(local).length > 0 && (
            <button className="btn" onClick={save}>
              Speichern
            </button>
          )}
        </div>
      </div>

      <div className="settings-wrap">
        <h3>Suche</h3>
        <div className="settings-grid">
          <Slider
            label="Ähnlichkeitsschwelle"
            settKey="search_threshold"
            description="Minimum-Score für Suchergebnisse (0 = alles, 1 = nur exakt)"
          />
          <Slider
            label="Duplikat-Schwelle"
            settKey="dupe_threshold"
            description="Ab wann ein Eintrag im Editor als Duplikat gewarnt wird"
          />
          <Slider
            label="Hybrid-Alpha (α)"
            settKey="hybrid_alpha"
            description="Gewichtung Semantik vs. BM25 (1 = rein semantisch)"
          />
          <div className="setting">
            <h6>Top-K Ergebnisse</h6>
            <div className="stepper">
              <button onClick={() => set('top_k', Math.max(1, (val('top_k') as number) - 1))}>−</button>
              <span className="v">{val('top_k')}</span>
              <button onClick={() => set('top_k', Math.min(50, (val('top_k') as number) + 1))}>+</button>
            </div>
            <small>Maximale Anzahl Suchergebnisse</small>
          </div>
        </div>

        <h3>Ollama (KI-Zusammenfassung)</h3>
        <div className="settings-grid">
          <div className="setting">
            <h6>Ollama URL</h6>
            <input
              className="txt"
              value={val('ollama_url') as string}
              onChange={(e) => set('ollama_url', e.target.value)}
              placeholder="http://ollama:11434"
            />
            <small>Leer lassen, wenn Ollama nicht verwendet wird</small>
          </div>
          <div className="setting">
            <h6>Modell</h6>
            <input
              className="txt"
              value={val('ollama_model') as string}
              onChange={(e) => set('ollama_model', e.target.value)}
              placeholder="llama3.2:3b"
            />
            <small>Muss auf dem Ollama-Server verfügbar sein</small>
          </div>
        </div>

        <h3>Branding</h3>
        <div className="settings-grid">
          <div className="setting">
            <h6>Akzentfarbe</h6>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
              <input
                type="color"
                value={val('branding_accent') as string}
                onChange={(e) => set('branding_accent', e.target.value)}
                style={{ width: 40, height: 40, border: '1px solid var(--primary--200)', cursor: 'pointer' }}
              />
              <input
                className="txt"
                value={val('branding_accent') as string}
                onChange={(e) => set('branding_accent', e.target.value)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13, flex: 1 }}
              />
            </div>
            <small>Wird sofort angewendet (CSS-Variable --base--action)</small>
          </div>
          <div className="setting">
            <h6>Schriftart (Font-Stack)</h6>
            <input
              className="txt"
              value={val('branding_font') as string}
              onChange={(e) => set('branding_font', e.target.value)}
              placeholder="Inter, system-ui, sans-serif"
            />
            <small>CSS font-family-Wert für Body und Überschriften</small>
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
