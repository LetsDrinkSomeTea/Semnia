import json
from sqlalchemy.orm import Session
from app.db.models import Entry, Chunk
from app.search.semantic import semantic_search


def search(
    db: Session,
    query: str,
    threshold: float = 0.4,
    top_k: int = 10,
    alpha: float = 0.7,  # unused, kept for API backwards compat
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
    mode: str = "hybrid",  # unused, kept for backwards compat
) -> list[dict]:
    sem_raw = semantic_search(db, query, top_k=top_k * 3, entry_type=entry_type, tag_filter=tag_filter)
    if not sem_raw:
        return []

    sem_scores = {eid: score for eid, score, _ in sem_raw}
    sem_chunk = {eid: cid for eid, _, cid in sem_raw}

    # Relative normalization: floor = noise average, ceiling = 1.0 (perfect cosine)
    scores = list(sem_scores.values())
    avg = sum(scores) / len(scores)
    denominator = 1.0 - avg

    def to_display(s: float) -> float:
        if denominator < 1e-6:
            return 0.0
        return max(0.0, (s - avg) / denominator)

    display = {eid: to_display(s) for eid, s in sem_scores.items()}
    filtered = {eid: s for eid, s in display.items() if s >= threshold}
    top_ids = sorted(filtered, key=lambda eid: -filtered[eid])[:top_k]

    if not top_ids:
        return []

    entries = {e.id: e for e in db.query(Entry).filter(Entry.id.in_(top_ids)).all()}

    chunk_ids = [sem_chunk[eid] for eid in top_ids if eid in sem_chunk]
    chunk_map: dict[int, Chunk] = {}
    if chunk_ids:
        chunks = db.query(Chunk).filter(Chunk.id.in_(chunk_ids)).all()
        chunk_map = {c.id: c for c in chunks}

    results = []
    for eid in top_ids:
        entry = entries.get(eid)
        if not entry:
            continue
        matched_chunk = chunk_map.get(sem_chunk.get(eid, -1))
        mct = matched_chunk.chunk_type if matched_chunk else "content"
        snippet, spans = _snippet(entry, query, mct)
        effective_title = entry.title or (entry.question or "")[:120] or (entry.content or "")[:120]
        results.append({
            "id": entry.id,
            "entry_type": entry.entry_type,
            "title": effective_title,
            "question": entry.question,
            "snippet": snippet,
            "highlight_spans": spans,
            "score": round(filtered[eid], 4),
            "tags": json.loads(entry.tags or "[]"),
            "call_count": entry.call_count,
            "matched_by": "semantic",
            "matched_chunk_type": mct,
            "matched_chunk_id": matched_chunk.id if matched_chunk else None,
        })

    return results


def _detect_bm25_chunk_type(entry: Entry, query: str) -> str:
    """Determine which field best matches the query via word-hit counting."""
    words = [w.lower() for w in query.split() if len(w) > 2]
    if not words:
        return "answer" if entry.entry_type == "qa" else "content"

    def hits(text: str) -> int:
        if not text:
            return 0
        low = text.lower()
        return sum(1 for w in words if w in low)

    tags_text = " ".join(json.loads(entry.tags or "[]"))
    scores: dict[str, int] = {
        "title": hits(entry.title),
        "tag": hits(tags_text),
    }
    if entry.entry_type == "qa":
        scores["question"] = hits(entry.question)
        scores["answer"] = hits(entry.answer)
    else:
        scores["content"] = hits(entry.content)

    best = max(scores, key=lambda k: scores[k])
    if scores[best] == 0:
        return "question" if entry.entry_type == "qa" else "content"
    return best


def _snippet(entry: Entry, query: str, chunk_type: str = "content", max_len: int = 260) -> tuple[str, list[list[int]]]:
    if chunk_type == "title":
        text = entry.title or ""
    elif chunk_type == "tag":
        text = " ".join(json.loads(entry.tags or "[]"))
    elif entry.entry_type == "qa":
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
