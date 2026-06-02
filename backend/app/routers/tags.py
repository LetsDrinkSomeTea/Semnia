import json
from collections import Counter

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import Entry, EntryTag

router = APIRouter(prefix="/api/tags", tags=["tags"])


@router.get("")
def list_tags(db: Session = Depends(get_db)):
    rows = (
        db.query(EntryTag.tag, func.count(EntryTag.entry_id).label("count"))
        .group_by(EntryTag.tag)
        .order_by(func.count(EntryTag.entry_id).desc())
        .all()
    )
    total = db.query(Entry).count()
    return {
        "total": total,
        "tags": [{"name": row.tag, "count": row.count} for row in rows],
    }


class SuggestTagsRequest(BaseModel):
    text: str = ""


@router.post("/suggest")
def suggest_tags(req: SuggestTagsRequest, db: Session = Depends(get_db)):
    from app.search.meilisearch_client import search as ms_search

    text = (req.text or "").strip()
    if len(text) < 10:
        return []

    hits = ms_search(query=text, threshold=0.1, top_k=15, hybrid=False)
    if not hits:
        return []

    entry_ids = [hit["id"] for hit in hits]
    entries = db.query(Entry).filter(Entry.id.in_(entry_ids)).all()

    counter: Counter = Counter()
    for e in entries:
        for tag in json.loads(e.tags or "[]"):
            counter[tag] += 1

    return [tag for tag, _ in counter.most_common(5)]
