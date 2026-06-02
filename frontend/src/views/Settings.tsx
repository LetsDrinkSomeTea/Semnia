import { useState, useEffect } from 'react'
import { getStatus } from '../api/client'
import { useSettings } from '../hooks/useSettings'
import type { ApiStatus } from '../types'

interface Props {
  toast: (msg: string, kind?: 'success' | 'error' | 'info') => void
}

function fmtBytes(b: number): string {
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

type StatusState = 'ok' | 'warn' | 'err'

interface StatusRow {
  label: string
  state: StatusState
  value: string
  sub?: string
}

export default function System(_props: Props) {
  const { settings, loading } = useSettings()
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [statusError, setStatusError] = useState(false)

  useEffect(() => {
    let evtSource: EventSource | null = null;

    const setupSSE = () => {
      // First fetch the initial state to immediately paint the UI without SSE delay
      getStatus()
        .then(s => {
          setStatus(s)
          setStatusError(false)
          
          evtSource = new EventSource('/api/status/stream')
          evtSource.onmessage = (e) => {
            try {
              setStatus(JSON.parse(e.data))
              setStatusError(false)
            } catch (err) {}
          }
          evtSource.onerror = () => setStatusError(true)
        })
        .catch(() => setStatusError(true))
    }

    setupSSE()

    return () => {
      if (evtSource) evtSource.close()
    }
  }, [])

  if (loading) return <main className="pb-main"><div className="empty"><p>Lädt…</p></div></main>

  const statusRows: StatusRow[] = [
    {
      label: 'Embedding-Modell',
      state: statusError ? 'err' : !status ? 'warn' : status.model_ready ? 'ok' : 'warn',
      value: statusError ? 'Nicht erreichbar' : !status ? 'Lädt…' : status.model_ready ? 'Bereit' : 'Lädt…',
      sub: status?.model,
    },
    {
      label: 'LLM',
      state: !status ? 'warn' : status.llm_status === 'ready' ? 'ok' : status.llm_status === 'error' ? 'err' : 'warn',
      value: !status ? '—' : status.llm_status === 'ready' ? 'Erreichbar' : status.llm_status === 'error' ? 'Fehler' : 'Nicht konfiguriert',
      sub: status?.llm_model || undefined,
    },
    {
      label: 'Datenbank',
      state: statusError ? 'err' : status ? 'ok' : 'warn',
      value: status ? `${status.entry_count} Einträge` : statusError ? 'Nicht erreichbar' : '—',
      sub: status ? `${fmtBytes(status.db_size_bytes)} · ${status.chunk_count} Chunks` : undefined,
    },
    {
      label: 'Embedding-Queue',
      state: !status ? 'warn' : status.unembedded_chunks === 0 ? 'ok' : 'warn',
      value: !status ? '—' : status.unembedded_chunks === 0 ? 'Alles eingebettet' : `${status.unembedded_chunks} ausstehend`,
      sub: status && status.unembedded_chunks > 0 ? `von ${status.chunk_count} Chunks` : undefined,
    },
    {
      label: 'Meilisearch',
      state: !status ? 'warn' : status.meilisearch_stats ? (status.meilisearch_stats.is_indexing ? 'warn' : 'ok') : 'err',
      value: !status ? '—' : status.meilisearch_stats ? `${status.meilisearch_stats.number_of_documents} indiziert${status.meilisearch_stats.is_indexing ? ' (arbeitet…)' : ''}` : 'Nicht erreichbar',
      sub: status?.meilisearch_stats ? 'Suchindex' : undefined,
    },
  ]

  const configGroups = [
    {
      label: 'System & Netzwerk',
      rows: [
        { label: 'Zeitzone', value: status?.tz ?? '—', env: 'TZ' },
        { label: 'Datenbank-Pfad', value: status?.db_path_str ?? '—', env: 'DB_PATH' },
        { label: 'Upload-Pfad', value: status?.upload_path ?? '—', env: 'UPLOAD_PATH' },
        { label: 'Meilisearch URL', value: status?.meilisearch_url ?? '—', env: 'MEILISEARCH_URL' },
        { label: 'CORS Origins', value: status?.cors_origins || 'Standard', env: 'CORS_ORIGINS' },
        { label: 'HuggingFace SSL-Prüfung', value: status ? (status.ssl_verify ? 'Aktiv' : 'Deaktiviert (Proxy Workaround)') : '—', env: 'SSL_VERIFY' },
        { label: 'Demo-Modus', value: status ? (status.demo ? 'Aktiv' : 'Inaktiv') : '—', env: 'DEMO' },
      ],
    },
    {
      label: 'Branding',
      rows: [
        { label: 'App Name', value: settings.branding_name || '—', env: 'APP_NAME' },
        { label: 'Akzentfarbe', value: settings.branding_accent || '—', env: 'ACCENT_COLOR' },
        { label: 'Schriftarten', value: settings.branding_font || '—', env: 'FONT_STACK' },
        { label: 'Eigenes Logo', value: settings.branding_logo_b64 ? 'Gesetzt' : 'Nicht gesetzt', env: 'BRANDING_LOGO_FILE' },
        { label: 'Custom CSS', value: settings.branding_custom_css ? 'Gesetzt' : 'Nicht gesetzt', env: 'CUSTOM_CSS / CUSTOM_CSS_FILE' },
      ],
    },
    {
      label: 'Embedding',
      rows: [
        { label: 'Embedding-Modell', value: status?.model ?? '—', env: 'EMBEDDING_MODEL' },
      ],
    },
    {
      label: 'Suche',
      rows: [
        { label: 'Ähnlichkeitsschwelle', value: settings.search_threshold?.toFixed(2) ?? '—', env: 'SEARCH_THRESHOLD' },
        { label: 'Duplikat-Schwelle', value: settings.dupe_threshold?.toFixed(2) ?? '—', env: 'DUPE_THRESHOLD' },
        { label: 'Top-K Ergebnisse', value: String(settings.top_k ?? '—'), env: 'TOP_K' },
      ],
    },
    {
      label: 'Chunking',
      rows: [
        { label: 'Chunk-Größe', value: `${settings.chunk_size} Zeichen`, env: 'CHUNK_SIZE' },
        { label: 'Chunk-Überlappung', value: `${settings.chunk_overlap} Zeichen`, env: 'CHUNK_OVERLAP' },
      ],
    },
    {
      label: 'LLM & Agent',
      rows: [
        { label: 'LLM URL', value: settings.llm_url || '—', env: 'LLM_URL' },
        { label: 'LLM Modell', value: settings.llm_model || '—', env: 'LLM_MODEL' },
        { label: 'API Key', value: settings.llm_api_key ? '••••••••' : '—', env: 'LLM_API_KEY' },
        { label: 'Max Agent Turns', value: String(settings.agent_max_turns ?? '—'), env: 'AGENT_MAX_TURNS' },
      ],
    },
  ]

  return (
    <main className="pb-main">
      <div className="page-head">
        <div>
          <h1 className="page-h">Systeminfo</h1>
          <p className="page-sub">Status und Konfiguration. Werte werden über Umgebungsvariablen gesetzt.</p>
        </div>
      </div>

      <p className="section-h">Status</p>
      <div className="sys-status-list">
        {statusRows.map((row) => (
          <div className="sys-status-row" key={row.label}>
            <div className={`sys-status-dot ${row.state}`} />
            <div className="sys-status-info">
              <span className="sys-status-name">{row.label}</span>
              {row.sub && <span className="sys-status-sub">{row.sub}</span>}
            </div>
            <span className={`sys-status-badge ${row.state}`}>{row.value}</span>
          </div>
        ))}
      </div>

      <p className="section-h">Konfiguration</p>
      <div className="sys-config">
        {configGroups.map(({ label, rows }) => (
          <div key={label}>
            <div className="sys-config-group-head">{label}</div>
            {rows.map(({ label: rowLabel, value, env }) => (
              <div className="sys-config-row" key={env}>
                <span className="sys-config-label">
                  {rowLabel}
                  <code className="env-tag">{env}</code>
                </span>
                <span className="sys-config-value">{value}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </main>
  )
}
