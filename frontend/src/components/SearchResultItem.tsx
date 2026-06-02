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
  const showContext =
    result.entry_type === 'qa' &&
    result.question &&
    result.matched_chunk_type !== 'question' &&
    result.matched_chunk_type !== 'title'

  return (
    <article className="result" onClick={() => onClick(result)} role="button">
      <ScoreBar score={result.score} />
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
