import json
from typing import Literal
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.db.session import get_db
from app.db.models import Setting, Entry
from app.search.hybrid import search as do_search

router = APIRouter(prefix="/api/search", tags=["search"])


class SearchRequest(BaseModel):
    query: str
    mode: Literal["semantic", "hybrid", "literal"] = "hybrid"
    threshold: float | None = None
    top_k: int | None = None
    tags: list[str] = []
    entry_type: str | None = None


class SummarizeRequest(BaseModel):
    entry_ids: list[int]
    query: str = ""


def _setting(db: Session, key: str, default):
    row = db.query(Setting).filter(Setting.key == key).first()
    return json.loads(row.value) if row else default


@router.post("")
def search(req: SearchRequest, db: Session = Depends(get_db)):
    threshold = req.threshold if req.threshold is not None else _setting(db, "search_threshold", 0.4)
    top_k = req.top_k if req.top_k is not None else _setting(db, "top_k", 10)
    alpha = _setting(db, "hybrid_alpha", 0.7)

    return do_search(
        db=db,
        query=req.query,
        mode=req.mode,
        threshold=threshold,
        top_k=top_k,
        alpha=alpha,
        entry_type=req.entry_type or None,
        tag_filter=req.tags or None,
    )


@router.post("/summarize")
async def summarize(req: SummarizeRequest, db: Session = Depends(get_db)):
    import httpx

    ollama_url = _setting(db, "ollama_url", "http://ollama:11434")
    model = _setting(db, "ollama_model", "llama3.2:3b")

    entries = db.query(Entry).filter(Entry.id.in_(req.entry_ids)).all()
    if not entries:
        raise HTTPException(404, "No entries found")

    parts = []
    for i, e in enumerate(entries[:5], 1):
        if e.entry_type == "qa":
            parts.append(f"[#{i}] Frage: {e.question}\nAntwort: {e.answer}")
        else:
            parts.append(f"[#{i}] {e.title}: {(e.content or '')[:600]}")

    prompt = (
        f"Beantworte folgende Frage in 2-4 Sätzen auf Basis der Quellen. Zitiere Quellen mit [#N].\n\n"
        f"Frage: {req.query}\n\nQuellen:\n" + "\n\n".join(parts) + "\n\nAntwort:"
    )

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{ollama_url}/api/generate",
                json={"model": model, "prompt": prompt, "stream": False},
            )
            resp.raise_for_status()
            return {"summary": resp.json().get("response", ""), "source_count": len(entries)}
    except Exception:
        raise HTTPException(503, "LLM-Dienst nicht erreichbar")
