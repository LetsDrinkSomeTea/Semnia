import json
from sqlalchemy.orm import Session
from app.db.models import Entry, Chunk
from app.search.semantic import semantic_search
from app.search.bm25 import fts_search


def search(
    db: Session,
    query: str,
    threshold: float = 0.4,
    top_k: int = 10,
    alpha: float = 0.7,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
    mode: str = "hybrid",  # kept for backwards compat, always runs hybrid
) -> list[dict]:
    sem_raw = semantic_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter)
    sem: dict[int, float] = {eid: score for eid, score, _ in sem_raw}
    sem_chunk: dict[int, int] = {eid: cid for eid, _, cid in sem_raw}

    bm25 = dict(fts_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter))
    all_ids = set(sem) | set(bm25)

    scored: dict[int, float] = {}
    matched_by: dict[int, str] = {}
    for rid in all_ids:
        s = sem.get(rid, 0.0)
        b = bm25.get(rid, 0.0)
        scored[rid] = alpha * s + (1 - alpha) * b
        if s > 0 and b > 0:
            matched_by[rid] = "both"
        elif s > 0:
            matched_by[rid] = "semantic"
        else:
            matched_by[rid] = "bm25"

    filtered = {rid: sc for rid, sc in scored.items() if sc >= threshold}
    top_ids = sorted(filtered, key=lambda rid: filtered[rid], reverse=True)[:top_k]

    if not top_ids:
        return []

    entries = {e.id: e for e in db.query(Entry).filter(Entry.id.in_(top_ids)).all()}

    # Resolve chunk_type for semantic matches
    sem_chunk_ids = [sem_chunk[eid] for eid in top_ids if eid in sem_chunk]
    chunk_type_map: dict[int, str] = {}
    if sem_chunk_ids:
        chunks = db.query(Chunk).filter(Chunk.id.in_(sem_chunk_ids)).all()
        chunk_type_map = {c.id: c.chunk_type for c in chunks}

    results = []
    for rid in top_ids:
        entry = entries.get(rid)
        if not entry:
            continue

        if rid in sem_chunk:
            mct = chunk_type_map.get(sem_chunk[rid], "content")
        else:
            mct = _detect_bm25_chunk_type(entry, query)

        snippet, spans = _snippet(entry, query, mct)
        results.append({
            "id": entry.id,
            "entry_type": entry.entry_type,
            "title": entry.title,
            "snippet": snippet,
            "highlight_spans": spans,
            "score": round(filtered[rid], 4),
            "tags": json.loads(entry.tags or "[]"),
            "call_count": entry.call_count,
            "matched_by": matched_by.get(rid, "semantic"),
            "matched_chunk_type": mct,
        })

    return results


def _detect_bm25_chunk_type(entry: Entry, query: str) -> str:
    """Determine which field (question/answer/content) the BM25 match came from."""
    if entry.entry_type != "qa":
        return "content"
    words = [w.lower() for w in query.split() if len(w) > 2]
    if not words:
        return "answer"

    def hits(text: str) -> int:
        if not text:
            return 0
        low = text.lower()
        return sum(1 for w in words if w in low)

    return "question" if hits(entry.question) >= hits(entry.answer) else "answer"


def _snippet(entry: Entry, query: str, chunk_type: str = "content", max_len: int = 260) -> tuple[str, list[list[int]]]:
    if entry.entry_type == "qa":
        text = (entry.question if chunk_type == "question" else entry.answer) or ""
    else:
        text = entry.content or ""
    if not text:
        return "", []

    q_words = [w.lower() for w in query.split() if len(w) > 2]
    start = 0
    if q_words:
        low = text.lower()
        for w in q_words:
            pos = low.find(w)
            if pos != -1:
                start = max(0, pos - 60)
                break

    raw = text[start: start + max_len]
    prefix = "…" if start > 0 else ""
    suffix = "…" if start + max_len < len(text) else ""
    snippet = prefix + raw + suffix

    offset = len(prefix)
    low_snippet = raw.lower()
    spans: list[list[int]] = []
    for w in q_words:
        p = 0
        while True:
            idx = low_snippet.find(w, p)
            if idx == -1:
                break
            spans.append([idx + offset, idx + offset + len(w)])
            p = idx + 1

    return snippet, spans
