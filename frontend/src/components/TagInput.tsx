import { useState } from 'react'

interface Props {
  tags: string[]
  onChange: (tags: string[]) => void
  suggestions?: string[]
}

export default function TagInput({ tags, onChange, suggestions = [] }: Props) {
  const [input, setInput] = useState('')

  const addTag = (val: string) => {
    const t = val.trim()
    if (!t || tags.includes(t)) { setInput(''); return }
    onChange([...tags, t])
    setInput('')
  }

  const removeTag = (tag: string) => onChange(tags.filter((t) => t !== tag))

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      addTag(input)
    } else if (e.key === 'Backspace' && !input && tags.length) {
      onChange(tags.slice(0, -1))
    }
  }

  const filtered = suggestions.filter(
    (s) => s.toLowerCase().includes(input.toLowerCase()) && !tags.includes(s),
  )

  return (
    <div style={{ position: 'relative' }}>
      <div className="editor-tags">
        {tags.map((tag) => (
          <span className="chip" key={tag}>
            {tag}
            <button className="x" type="button" onClick={() => removeTag(tag)}>
              ×
            </button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => input && addTag(input)}
          placeholder={tags.length ? '' : 'Tag eingeben…'}
        />
      </div>
      {input && filtered.length > 0 && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: '#fff',
            border: '1px solid var(--primary--200)',
            borderTop: 0,
            zIndex: 10,
            maxHeight: 160,
            overflowY: 'auto',
          }}
        >
          {filtered.slice(0, 8).map((s) => (
            <div
              key={s}
              style={{
                padding: '8px 12px',
                fontSize: 13,
                cursor: 'pointer',
                color: 'var(--base--black)',
              }}
              onMouseDown={(e) => { e.preventDefault(); addTag(s) }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
