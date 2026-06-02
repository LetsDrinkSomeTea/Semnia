import json
import re
from difflib import get_close_matches
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.config import DEFAULT_SETTINGS
from app.db.session import get_db
from app.db.models import Setting, Entry, Chunk


router = APIRouter(prefix="/api/search", tags=["search"])


_VALID_ENTRY_TYPES = frozenset({"qa", "document"})


class SearchRequest(BaseModel):
    query: str
    threshold: float | None = None
    top_k: int | None = None
    page: int = 1
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

    from app.search.meilisearch_client import search as ms_search
    results = ms_search(
        query=req.query,
        threshold=threshold,
        top_k=top_k,
        page=req.page,
        entry_type=req.entry_type or None,
        tag_filter=req.tags or None,
        hybrid=True
    )
    return {"items": results, "has_more": len(results) >= top_k}


@router.post("/fuzzy")
def fuzzy_search(req: SearchRequest, db: Session = Depends(get_db)):
    """Typo-tolerant search now powered by Meilisearch."""
    req.validate_entry_type()
    top_k = req.top_k if req.top_k is not None else _setting(db, "top_k", 10)
    
    from app.search.meilisearch_client import search as ms_search
    results = ms_search(
        query=req.query,
        threshold=0.0,
        top_k=top_k,
        page=req.page,
        entry_type=req.entry_type or None,
        tag_filter=req.tags or None,
        hybrid=False
    )
    
    return {"items": results, "has_more": len(results) >= top_k, "suggestion": None}


@router.post("/summarize")
async def summarize(req: SummarizeRequest, db: Session = Depends(get_db)):
    from fastapi.responses import StreamingResponse
    from agents import Agent, Runner, OpenAIChatCompletionsModel
    from openai import AsyncOpenAI

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
    
    instruction = (
        "Beantworte Fragen in 2-4 Sätzen ausschließlich auf Basis der gegebenen Quellen. "
        "Zitiere mit [#N] nur Quellen, die du tatsächlich verwendet hast. "
        "Nicht relevante Quellen ignorierst du vollständig."
    )
    
    client_kwargs = {}
    if llm_api_key:
        client_kwargs["api_key"] = llm_api_key
    if llm_url:
        client_kwargs["base_url"] = llm_url

    client = AsyncOpenAI(**client_kwargs)
    custom_model = OpenAIChatCompletionsModel(model=llm_model, openai_client=client)

    agent = Agent(
        name="Summarizer",
        instructions=instruction,
        model=custom_model
    )
    
    agent_input = f"Frage: {req.query}\n\n{sources_block}"

    async def generate():
        try:
            stream = Runner.run_streamed(agent, input=agent_input)
            async for event in stream.stream_events():
                if hasattr(event, "data") and type(event.data).__name__ == "ResponseTextDeltaEvent":
                    token = getattr(event.data, "delta", "")
                    if token:
                        yield f"data: {json.dumps({'type': 'message', 'text': token})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
