from sqlalchemy import text
from sqlalchemy.orm import Session


def fts_search(
    db: Session,
    query: str,
    top_k: int = 30,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
) -> list[tuple[int, float]]:
    """Returns (entry_id, normalized_bm25_score) pairs sorted by score desc."""
    query_escaped = _escape_fts(query)
    if not query_escaped:
        return []

    rows = db.execute(
        text("""
            SELECT rowid, bm25(entries_fts) AS score
            FROM entries_fts
            WHERE entries_fts MATCH :q
            ORDER BY score
            LIMIT :k
        """),
        {"q": query_escaped, "k": top_k * 3},
    ).fetchall()

    if not rows:
        return []

    # FTS5 bm25 is negative; negate + normalize to [0,1]
    pairs = [(-float(score), int(rowid)) for rowid, score in rows]
    max_score = max(s for s, _ in pairs) or 1.0
    results = [(rid, s / max_score) for s, rid in pairs]
    results.sort(key=lambda x: x[1], reverse=True)

    if entry_type or tag_filter:
        results = _apply_filters(db, results, entry_type, tag_filter)

    return results[:top_k]


def _apply_filters(
    db: Session,
    results: list[tuple[int, float]],
    entry_type: str | None,
    tag_filter: list[str] | None,
) -> list[tuple[int, float]]:
    from app.db.models import Entry, EntryTag

    q = db.query(Entry.id)
    if entry_type:
        q = q.filter(Entry.entry_type == entry_type)
    if tag_filter:
        for tag in tag_filter:
            q = q.join(EntryTag, Entry.id == EntryTag.entry_id).filter(EntryTag.tag == tag)

    valid_ids = {row[0] for row in q.all()}
    return [(rid, s) for rid, s in results if rid in valid_ids]


def _escape_fts(query: str) -> str:
    special = '"*(){}[]^-~'
    cleaned = "".join(c for c in query if c not in special).strip()
    words = [w for w in cleaned.split() if w]
    if not words:
        return ""
    return " ".join(f'"{w}"' for w in words)
