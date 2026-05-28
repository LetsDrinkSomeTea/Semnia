interface Props {
  score: number
}

export default function ScoreBar({ score }: Props) {
  const pct = Math.round(score * 100)
  return (
    <div className="score-block">
      <span className="score-num">{pct}</span>
      <div className="score-meter" style={{ '--m': `${pct}%` } as React.CSSProperties} />
      <span className="score-label">Relevanz</span>
    </div>
  )
}
