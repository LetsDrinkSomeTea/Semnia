import { useState, useEffect, useCallback } from 'react'
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom'
import { useSettings } from './hooks/useSettings'
import { getStatus } from './api/client'
import type { ApiStatus } from './types'
import Search from './views/Search'
import Browse from './views/Browse'
import Detail from './views/Detail'
import QAEditor from './views/QAEditor'
import Import from './views/Import'
import Settings from './views/Settings'

interface Toast {
  id: number
  msg: string
  kind: 'success' | 'error' | 'info'
}

let toastId = 0

function AppShell() {
  const { settings, loading } = useSettings()
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const location = useLocation()

  useEffect(() => {
    getStatus().then(setStatus).catch(() => {})
    const t = setInterval(() => getStatus().then(setStatus).catch(() => {}), 30000)
    return () => clearInterval(t)
  }, [])

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId
    setToasts((ts) => [...ts, { id, msg, kind }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000)
  }, [])

  const pillClass = status?.model_ready ? 'model-pill ready' : 'model-pill loading'

  if (loading) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header className="pb-topbar">
        <NavLink to="/search" className="logo-wrap">
          <span className="logo-text">
            Wissens<span className="accent">db</span>
          </span>
        </NavLink>
        <div className="sep" />
        <nav className="nav">
          {[
            { to: '/search', label: 'Suche' },
            { to: '/browse', label: 'Übersicht' },
            { to: '/editor/new', label: 'Neu' },
            { to: '/import', label: 'Import' },
            { to: '/settings', label: 'Einstellungen' },
          ].map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? 'on' : '')}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className="right">
          {status && (
            <span className="stats">{status.entry_count} Einträge</span>
          )}
          <button className={pillClass} title={status?.model ?? 'Modell'}>
            <span className="dot" />
            {status?.model ?? 'Modell'}
          </button>
        </div>
      </header>

      <Routes>
        <Route path="/search" element={<Search toast={toast} settings={settings} />} />
        <Route path="/browse" element={<Browse toast={toast} />} />
        <Route path="/entries/:id" element={<Detail toast={toast} />} />
        <Route path="/editor/new" element={<QAEditor toast={toast} settings={settings} />} />
        <Route path="/editor/:id" element={<QAEditor toast={toast} settings={settings} />} />
        <Route path="/import" element={<Import toast={toast} />} />
        <Route path="/settings" element={<Settings toast={toast} />} />
        <Route path="*" element={<Search toast={toast} settings={settings} />} />
      </Routes>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}
