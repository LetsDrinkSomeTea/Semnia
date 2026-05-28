import re
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.search.bm25 import normalize_umlauts, _apply_filters


def fuzzy_search(
    db: Session,
    query: str,
    top_k: int = 10,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
) -> list[tuple[int, float]]:
    """OR-mode FTS5 search — matches entries containing any query token (trigram-tolerant)."""
    normalized = normalize_umlauts(query)
    words = [w for w in re.split(r'\W+', normalized) if len(w) >= 3]
    if not words:
        return []
    q_or = " OR ".join(f'"{w}"' for w in words)
    rows = db.execute(
        text("""
            SELECT rowid, bm25(entries_fts, 1.3, 1.15, 1.0, 1.0, 1.2) AS score
            FROM entries_fts WHERE entries_fts MATCH :q ORDER BY score LIMIT :k
        """),
        {"q": q_or, "k": top_k * 3},
    ).fetchall()
    if not rows:
        return []
    pairs = [(-float(score), int(rowid)) for rowid, score in rows]
    max_score = max(s for s, _ in pairs) or 1.0
    results = [(rid, s / max_score) for s, rid in pairs]
    results.sort(key=lambda x: -x[1])
    if entry_type or tag_filter:
        results = _apply_filters(db, results, entry_type, tag_filter)
    return results[:top_k]
