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

const navItems = [
  { to: '/search', label: 'Suche' },
  { to: '/browse', label: 'Übersicht' },
  { to: '/editor/new', label: 'Neu' },
  { to: '/import', label: 'Import' },
  { to: '/systeminfo', label: 'Systeminfo' },
]

function AppShell() {
  const { settings, loading } = useSettings()
  const [status, setStatus] = useState<ApiStatus | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  useEffect(() => { setNavOpen(false) }, [location.pathname])

  useEffect(() => {
    const fetchStatus = () =>
      getStatus()
        .then(s => setStatus(s))
        .catch(() => {})
    fetchStatus()
    const t = setInterval(fetchStatus, 30000)
    return () => clearInterval(t)
  }, [])

  const toast = useCallback((msg: string, kind: Toast['kind'] = 'info') => {
    const id = ++toastId
    setToasts((ts) => [...ts, { id, msg, kind }])
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000)
  }, [])

  const ollamaReady = status?.ollama_ready ?? false

  if (loading) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <header className="pb-topbar">
        <NavLink to="/search" className="logo-wrap">
          <span className="logo-text">
            {(() => {
              const name = settings.branding_name || 'Semnia'
              const cut = Math.max(0, name.length - 3)
              return <>{name.slice(0, cut)}<span className="accent">{name.slice(cut)}</span></>
            })()}
          </span>
        </NavLink>
        <div className="sep" />
        <nav className={`nav ${navOpen ? 'open' : ''}`}>
          {navItems.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? 'on' : '')}
              onClick={() => setNavOpen(false)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <div className="right">
          {status && <span className="stats">{status.entry_count} Einträge</span>}
        </div>
        <button
          className={`mobile-menu-btn ${navOpen ? 'open' : ''}`}
          onClick={() => setNavOpen((o) => !o)}
          aria-label="Navigation öffnen"
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} />}

      <Routes>
        <Route path="/search" element={<Search toast={toast} settings={settings} ollamaReady={ollamaReady} />} />
        <Route path="/browse" element={<Browse toast={toast} />} />
        <Route path="/entries/:id" element={<Detail toast={toast} />} />
        <Route path="/editor/new" element={<QAEditor toast={toast} settings={settings} />} />
        <Route path="/editor/:id" element={<QAEditor toast={toast} settings={settings} />} />
        <Route path="/import" element={<Import toast={toast} />} />
        <Route path="/systeminfo" element={<Settings toast={toast} />} />
        <Route path="*" element={<Search toast={toast} settings={settings} ollamaReady={ollamaReady} />} />
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
