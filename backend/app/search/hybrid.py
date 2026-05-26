import json
from sqlalchemy.orm import Session
from app.db.models import Entry
from app.search.semantic import semantic_search
from app.search.bm25 import fts_search


def search(
    db: Session,
    query: str,
    mode: str = "hybrid",
    threshold: float = 0.4,
    top_k: int = 10,
    alpha: float = 0.7,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
) -> list[dict]:
    if mode == "literal":
        scored = dict(fts_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter))
    elif mode == "semantic":
        scored = dict(semantic_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter))
    else:
        sem = dict(semantic_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter))
        bm25 = dict(fts_search(db, query, top_k=top_k * 2, entry_type=entry_type, tag_filter=tag_filter))
        all_ids = set(sem) | set(bm25)
        scored = {rid: alpha * sem.get(rid, 0.0) + (1 - alpha) * bm25.get(rid, 0.0) for rid in all_ids}

    filtered = {rid: s for rid, s in scored.items() if s >= threshold}
    top_ids = sorted(filtered, key=lambda rid: filtered[rid], reverse=True)[:top_k]

    if not top_ids:
        return []

    entries = {e.id: e for e in db.query(Entry).filter(Entry.id.in_(top_ids)).all()}

    results = []
    for rid in top_ids:
        entry = entries.get(rid)
        if not entry:
            continue
        snippet, spans = _snippet(entry, query)
        results.append({
            "id": entry.id,
            "entry_type": entry.entry_type,
            "title": entry.title,
            "snippet": snippet,
            "highlight_spans": spans,
            "score": round(filtered[rid], 4),
            "tags": json.loads(entry.tags or "[]"),
            "call_count": entry.call_count,
        })

    return results


def _snippet(entry: Entry, query: str, max_len: int = 260) -> tuple[str, list[list[int]]]:
    text = (entry.answer if entry.entry_type == "qa" else entry.content) or ""
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
