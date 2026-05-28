import { useState, useEffect } from 'react'
import { getSettings } from '../api/client'
import type { AppSettings } from '../types'

const DEFAULTS: AppSettings = {
  search_threshold: 0.4,
  dupe_threshold: 0.92,
  top_k: 10,
  hybrid_alpha: 0.7,
  chunk_size: 1500,
  chunk_overlap: 200,
  branding_name: 'Semnia',
  branding_accent: '#cc0033',
  branding_font: '',
  branding_logo_b64: '',
  branding_custom_css: '',
  llm_url: 'https://api.openai.com/v1',
  llm_model: 'gpt-5-mini',
  llm_api_key: '',
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

  return { settings, loading, refresh }
}

function applyBranding(s: AppSettings) {
  const root = document.documentElement
  if (s.branding_accent) root.style.setProperty('--base--action', s.branding_accent)
  if (s.branding_font) {
    root.style.setProperty('--font-body', s.branding_font)
    root.style.setProperty('--font-head', s.branding_font)
  }
  // Custom CSS
  const prev = document.getElementById('semnia-custom-css')
  if (prev) prev.remove()
  if (s.branding_custom_css) {
    const style = document.createElement('style')
    style.id = 'semnia-custom-css'
    style.textContent = s.branding_custom_css
    document.head.appendChild(style)
  }

  // Page title
  if (s.branding_name) document.title = s.branding_name
}
