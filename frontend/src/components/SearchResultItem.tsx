import React, { useState } from 'react'
import type { SearchResult } from '../types'
import ScoreBar from './ScoreBar'
import EntryTypeBadge from './EntryTypeBadge'
import FieldChip from './FieldChip'
import { renderSnippet } from '../utils/textFormatting'

interface Props {
  result: SearchResult
  onClick: (r: SearchResult) => void
  onClickTag: (tag: string) => void
}

export default function SearchResultItem({ result, onClick, onClickTag }: Props) {
  const [showReasoning, setShowReasoning] = useState(false)
  const showContext =
    result.entry_type === 'qa' &&
    result.question &&
    result.matched_chunk_type !== 'question' &&
    result.matched_chunk_type !== 'title'

  return (
    <article className={`result ${result.matched_by === 'agent' ? 'result--browse' : ''}`} onClick={() => onClick(result)} role="button">
      {result.matched_by !== 'agent' && <ScoreBar score={result.score} />}
      <div>
        <h3 className="q">{result.display_title}</h3>
        {showContext && (
          <p className="result-context">
            {result.question!.length > 100
              ? result.question!.slice(0, 100) + '…'
              : result.question}
          </p>
        )}
        {result.snippet && (
          <p className="snippet">
            {renderSnippet(result.snippet, result.highlight_spans)}
          </p>
        )}
        <div className="meta-row">
          <div className="meta-system">
            <EntryTypeBadge type={result.entry_type} />
            <FieldChip chunk_type={result.matched_chunk_type} />
            {result.reasoning && (
              <div 
                style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
                onMouseEnter={() => setShowReasoning(true)}
                onMouseLeave={() => setShowReasoning(false)}
                onClick={(e) => { e.stopPropagation(); setShowReasoning(!showReasoning); }}
              >
                <span className="chip" style={{ cursor: 'help', backgroundColor: 'var(--branding-accent)', color: 'white', border: 'none', marginLeft: 4 }}>
                  💡 Begründung
                </span>
                {showReasoning && (
                  <div style={{
                    position: 'absolute',
                    bottom: '100%',
                    left: '0',
                    marginBottom: '8px',
                    width: 'max-content',
                    maxWidth: '450px',
                    backgroundColor: '#fff',
                    border: '1px solid var(--primary--200)',
                    borderRadius: '8px',
                    padding: '12px',
                    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
                    zIndex: 999,
                    fontSize: '0.9rem',
                    lineHeight: '1.4',
                    color: 'var(--c-text)',
                    whiteSpace: 'normal',
                    textAlign: 'left'
                  }}>
                    <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--branding-accent)', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Agent Reasoning</div>
                    {result.reasoning}
                  </div>
                )}
              </div>
            )}
          </div>
          {result.tags.length > 0 && (
            <div className="meta-tags">
              {result.tags.map((t) => (
                <span
                  className="chip"
                  key={t}
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onClickTag(t)
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="right-side">
        <span>{result.call_count}×</span>
      </div>
    </article>
  )
}
