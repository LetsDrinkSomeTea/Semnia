import { useState, useEffect } from 'react'
import { getSettings } from '../api/client'
import type { AppSettings } from '../types'

const DEFAULTS: AppSettings = {
  search_threshold: 0.4,
  dupe_threshold: 0.92,
  top_k: 10,
  hybrid_alpha: 0.7,
  branding_accent: '#cc0033',
  branding_font: '',
  branding_logo_b64: '',
  ollama_url: 'http://ollama:11434',
  ollama_model: 'llama3.2:3b',
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSettings()
      .then((s) => {
        setSettings(s)
        applyBranding(s)
      })
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [])

  const refresh = () =>
    getSettings().then((s) => {
      setSettings(s)
      applyBranding(s)
      return s
    })

  return { settings, loading, refresh, setSettings }
}

function applyBranding(s: AppSettings) {
  const root = document.documentElement
  if (s.branding_accent) {
    root.style.setProperty('--base--action', s.branding_accent)
  }
  if (s.branding_font) {
    root.style.setProperty('--font-body', s.branding_font)
    root.style.setProperty('--font-head', s.branding_font)
  }
}
