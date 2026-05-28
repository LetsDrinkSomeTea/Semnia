import json
import re
from difflib import get_close_matches
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.config import DEFAULT_SETTINGS
from app.db.session import get_db
from app.db.models import Setting, Entry, Chunk
from app.search.hybrid import search as do_search, _snippet

router = APIRouter(prefix="/api/search", tags=["search"])


_VALID_ENTRY_TYPES = frozenset({"qa", "document"})


class SearchRequest(BaseModel):
    query: str
    threshold: float | None = None
    top_k: int | None = None
    tags: list[str] = []
    entry_type: str | None = None

    def validate_entry_type(self) -> None:
        if self.entry_type and self.entry_type not in _VALID_ENTRY_TYPES:
            from fastapi import HTTPException
            raise HTTPException(400, f"Ungültiger entry_type. Erlaubt: {sorted(_VALID_ENTRY_TYPES)}")


class SourceRef(BaseModel):
    entry_id: int
    chunk_id: int | None = None


class SummarizeRequest(BaseModel):
    sources: list[SourceRef]
    query: str = ""


def _setting(db: Session, key: str, default):
    row = db.query(Setting).filter(Setting.key == key).first()
    return json.loads(row.value) if row else default


def _document_context(db: Session, entry: Entry, chunk_id: int | None, window: int = 3) -> str:
    if chunk_id is not None:
        anchor = db.query(Chunk).filter(Chunk.id == chunk_id).first()
        if anchor:
            neighbors = (
                db.query(Chunk)
                .filter(
                    Chunk.entry_id == entry.id,
                    Chunk.chunk_type == "content",
                    Chunk.chunk_index >= anchor.chunk_index - window,
                    Chunk.chunk_index <= anchor.chunk_index + window,
                )
                .order_by(Chunk.chunk_index)
                .all()
            )
            return "\n\n".join(c.content for c in neighbors)
    # Fallback: first ~1500 chars of full content
    return (entry.content or "")[:1500]


@router.post("")
def search(req: SearchRequest, db: Session = Depends(get_db)):
    req.validate_entry_type()
    threshold = req.threshold if req.threshold is not None else _setting(db, "search_threshold", DEFAULT_SETTINGS["search_threshold"])
    top_k = req.top_k if req.top_k is not None else _setting(db, "top_k", 10)
    alpha = _setting(db, "hybrid_alpha", 0.7)

    return do_search(
        db=db,
        query=req.query,
        threshold=threshold,
        top_k=top_k,
        alpha=alpha,
        entry_type=req.entry_type or None,
        tag_filter=req.tags or None,
    )


@router.post("/fuzzy")
def fuzzy_search(req: SearchRequest, db: Session = Depends(get_db)):
    """Typo-tolerant search. Returns {results, suggestion} where suggestion is the corrected query."""
    req.validate_entry_type()
    from collections import Counter
    top_k = req.top_k if req.top_k is not None else _setting(db, "top_k", 10)
    query_words = [w.lower() for w in req.query.split() if len(w) >= 3]
    if not query_words:
        return {"results": [], "suggestion": None}

    q = db.query(Entry)
    if req.entry_type:
        q = q.filter(Entry.entry_type == req.entry_type)
    entries = q.all()

    scored: list[tuple[Entry, float]] = []
    for entry in entries:
        raw = " ".join(filter(None, [entry.title, entry.question, entry.answer, entry.content]))
        text_words = list({w for w in re.split(r"\W+", raw.lower()) if len(w) >= 3})
        hits = sum(1 for qw in query_words if get_close_matches(qw, text_words, n=1, cutoff=0.75))
        if hits:
            scored.append((entry, hits / len(query_words)))

    scored.sort(key=lambda x: x[1], reverse=True)

    # Build suggestion: for each query word, find the most common close match in top results
    suggestions: dict[str, str] = {}
    for qw in query_words:
        candidates: list[str] = []
        for entry, _ in scored[:5]:
            raw = " ".join(filter(None, [entry.title, entry.question, entry.answer, entry.content]))
            text_words = list({w for w in re.split(r"\W+", raw.lower()) if len(w) >= 3})
            matches = get_close_matches(qw, text_words, n=1, cutoff=0.75)
            if matches and matches[0] != qw:
                candidates.append(matches[0])
        if candidates:
            suggestions[qw] = Counter(candidates).most_common(1)[0][0]

    suggestion_parts = []
    for w in req.query.split():
        lw = w.lower()
        suggestion_parts.append(suggestions.get(lw, w))
    suggestion = " ".join(suggestion_parts)
    if suggestion.lower() == req.query.lower():
        suggestion = None

    results = []
    for entry, score in scored[:top_k]:
        # Determine which chunk type matched for highlight routing
        from app.search.hybrid import _detect_bm25_chunk_type, _snippet as hybrid_snippet
        mct = _detect_bm25_chunk_type(entry, req.query)
        snippet, spans = hybrid_snippet(entry, req.query, mct)
        effective_title = entry.title or (entry.question or "")[:120] or (entry.content or "")[:120]
        results.append({
            "id": entry.id,
            "entry_type": entry.entry_type,
            "title": effective_title,
            "snippet": snippet,
            "highlight_spans": spans,
            "score": round(score, 4),
            "tags": json.loads(entry.tags or "[]"),
            "call_count": entry.call_count,
            "matched_by": "fuzzy",
            "matched_chunk_type": mct,
        })

    return {"results": results, "suggestion": suggestion}


@router.post("/summarize")
async def summarize(req: SummarizeRequest, db: Session = Depends(get_db)):
    import httpx
    from fastapi.responses import StreamingResponse

    llm_url = _setting(db, "llm_url", "https://api.openai.com/v1").rstrip("/")
    llm_model = _setting(db, "llm_model", "gpt-5-mini")
    llm_api_key = _setting(db, "llm_api_key", "")

    source_refs = req.sources[:5]
    entry_ids = [s.entry_id for s in source_refs]
    entries_map = {e.id: e for e in db.query(Entry).filter(Entry.id.in_(entry_ids)).all()}
    if not entries_map:
        raise HTTPException(404, "No entries found")

    parts = []
    for i, src in enumerate(source_refs, 1):
        e = entries_map.get(src.entry_id)
        if not e:
            continue
        if e.entry_type == "qa":
            parts.append(
                f"### Quelle {i}: {e.title or e.question or ''}\n"
                f"Frage: {e.question or '—'}\n"
                f"Antwort: {e.answer or '—'}"
            )
        else:
            context = _document_context(db, e, src.chunk_id, window=3)
            parts.append(f"### Quelle {i}: {e.title or ''}\n{context}")

    sources_block = "\n\n---\n\n".join(parts)
    messages = [
        {
            "role": "system",
            "content": (
                "Beantworte Fragen in 2-4 Sätzen ausschließlich auf Basis der gegebenen Quellen. "
                "Zitiere mit [#N] nur Quellen, die du tatsächlich verwendet hast. "
                "Nicht relevante Quellen ignorierst du vollständig."
            ),
        },
        {
            "role": "user",
            "content": f"Frage: {req.query}\n\n{sources_block}",
        },
    ]

    async def generate():
        try:
            headers = {"Authorization": f"Bearer {llm_api_key}"} if llm_api_key else {}
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{llm_url}/chat/completions",
                    headers=headers,
                    json={"model": llm_model, "messages": messages, "stream": True},
                ) as resp:
                    if resp.status_code != 200:
                        yield f"data: {json.dumps({'error': 'LLM-Dienst nicht erreichbar'})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            yield f"data: {json.dumps({'done': True})}\n\n"
                            return
                        try:
                            chunk = json.loads(payload)
                            token = chunk["choices"][0]["delta"].get("content", "")
                            if token:
                                yield f"data: {json.dumps({'token': token})}\n\n"
                        except (json.JSONDecodeError, KeyError, IndexError):
                            pass
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
