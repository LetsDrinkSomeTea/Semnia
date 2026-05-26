import EntryTypeBadge from './EntryTypeBadge'

interface Props {
  title: string
  entry_type: 'qa' | 'document'
  meta?: string
  onClick: () => void
}

export default function EntryRow({ title, entry_type, meta, onClick }: Props) {
  return (
    <div className="entry-row" onClick={onClick} role="button">
      <EntryTypeBadge type={entry_type} />
      <span className="entry-row-title">{title}</span>
      {meta && <span className="entry-row-meta">{meta}</span>}
    </div>
  )
}
