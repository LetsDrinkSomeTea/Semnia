interface Props {
  type: 'qa' | 'document'
}

export default function EntryTypeBadge({ type }: Props) {
  return (
    <span className={`type-badge ${type}`}>
      {type === 'qa' ? 'Q&A' : 'DOK'}
    </span>
  )
}
