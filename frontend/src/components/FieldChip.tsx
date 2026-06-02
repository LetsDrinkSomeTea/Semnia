const FIELD_LABELS: Record<string, string> = {
  question: 'Frage',
  answer: 'Antwort',
  title: 'Titel',
  tag: 'Tag',
  content: 'Inhalt',
}

export default function FieldChip({ chunk_type }: { chunk_type?: string }) {
  if (!chunk_type) return null
  const label = FIELD_LABELS[chunk_type]
  if (!label) return null
  return <span className={`field-chip field-chip--${chunk_type}`}>{label}</span>
}
