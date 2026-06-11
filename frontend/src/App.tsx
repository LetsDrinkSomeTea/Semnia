import { useState, useEffect, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Navigate,
  useLocation,
} from "react-router-dom";
import { useSettings } from "./hooks/useSettings";
import { getStatus } from "./api/client";
import type { ApiStatus } from "./types";
import Search from "./views/Search";
import Detail from "./views/Detail";
import QAEditor from "./views/QAEditor";
import Create from "./views/Create";
import Settings from "./views/Settings";
import AgenticSearch from "./views/AgenticSearch";

interface Toast {
  id: number;
  msg: string;
  kind: "success" | "error" | "info";
}

let toastId = 0;

function AppShell() {
  const { settings, loading } = useSettings();
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    const fetchStatus = () =>
      getStatus()
        .then((s) => setStatus(s))
        .catch(() => {});
    fetchStatus();
    const t = setInterval(fetchStatus, 30000);
    return () => clearInterval(t);
  }, []);

  const toast = useCallback((msg: string, kind: Toast["kind"] = "info") => {
    const id = ++toastId;
    setToasts((ts) => [...ts, { id, msg, kind }]);
    setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), 4000);
  }, []);

  const llmReady = status?.llm_status === "ready";

  const navItems = [
    { to: "/search", label: "Suche", show: true },
    { to: "/agent", label: "Agentic Search", show: llmReady },
    { to: "/create", label: "Erstellen", show: true },
    { to: "/systeminfo", label: "Systeminfo", show: true },
  ];

  if (loading) return null;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}
    >
      <header className="pb-topbar">
        <NavLink to="/search" className="logo-wrap">
          <span className="logo-text">
            {(() => {
              const name = settings.branding_name || "Semnia";
              const cut = Math.max(0, name.length - 3);
              return (
                <>
                  {name.slice(0, cut)}
                  <span className="accent">{name.slice(cut)}</span>
                </>
              );
            })()}
          </span>
        </NavLink>
        <div className="sep" />
        <nav className={`nav ${navOpen ? "open" : ""}`}>
          {navItems.map(
            ({ to, label, show }) =>
              show && (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => (isActive ? "on" : "")}
                  onClick={() => setNavOpen(false)}
                >
                  {label}
                </NavLink>
              ),
          )}
        </nav>
        <div className="spacer" />
        <div className="right">
          {status && (
            <span className="stats">{status.entry_count} Einträge</span>
          )}
        </div>
        <button
          className={`mobile-menu-btn ${navOpen ? "open" : ""}`}
          onClick={() => setNavOpen((o) => !o)}
          aria-label="Navigation öffnen"
        >
          <span />
          <span />
          <span />
        </button>
      </header>

      {navOpen && (
        <div className="nav-overlay" onClick={() => setNavOpen(false)} />
      )}

      <Routes>
        <Route
          path="/search"
          element={
            <Search toast={toast} settings={settings} llmReady={llmReady} />
          }
        />
        {llmReady && (
          <Route path="/agent" element={<AgenticSearch toast={toast} />} />
        )}
        <Route path="/browse" element={<Navigate to="/search" replace />} />
        <Route path="/entries/:id" element={<Detail toast={toast} />} />
        <Route path="/editor/new" element={<Navigate to="/create" replace />} />
        <Route
          path="/editor/:id"
          element={<QAEditor toast={toast} settings={settings} />}
        />
        <Route path="/import" element={<Navigate to="/create" replace />} />
        <Route
          path="/create"
          element={<Create toast={toast} settings={settings} />}
        />
        <Route path="/systeminfo" element={<Settings toast={toast} />} />
        <Route
          path="*"
          element={
            <Search toast={toast} settings={settings} llmReady={llmReady} />
          }
        />
      </Routes>

      <div className="toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
