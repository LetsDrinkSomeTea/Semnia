import json
import numpy as np
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.config import DEFAULT_SETTINGS
from app.db.session import get_db
from app.db.models import Entry, EntryTag, Chunk, Setting
from app.embeddings.queue import enqueue_entry_chunks

router = APIRouter(prefix="/api/entries", tags=["entries"])


class QACreate(BaseModel):
    title: str = ""
    question: str
    answer: str
    tags: list[str] = []


class QAUpdate(BaseModel):
    title: str | None = None
    question: str | None = None
    answer: str | None = None
    content: str | None = None
    tags: list[str] | None = None


class DocCreate(BaseModel):
    title: str = ""
    content: str
    tags: list[str] = []


class DupeCheckRequest(BaseModel):
    question: str
    answer: str


def _sync_fts(db: Session, entry: Entry) -> None:
    # Removed FTS5 sync. Data is synced to Meilisearch via chunk queue.
    pass


def _delete_chunks_vec(db: Session, entry_id: int) -> None:
    from app.search.meilisearch_client import delete_chunks_from_meili
    chunk_ids = [c.id for c in db.query(Chunk.id).filter(Chunk.entry_id == entry_id).all()]
    if chunk_ids:
        delete_chunks_from_meili(chunk_ids)


def _get_setting(db: Session, key: str, default):
    row = db.query(Setting).filter(Setting.key == key).first()
    return json.loads(row.value) if row else default


def _create_doc_chunks(db: Session, entry_id: int, content: str, chunk_size: int = 1500, chunk_overlap: int = 200) -> None:
    from app.import_.chunker import chunk_text
    chunks = chunk_text(content, max_chars=chunk_size, overlap_chars=chunk_overlap)
    if not chunks:
        chunks = [content] if content.strip() else []
    for i, c in enumerate(chunks):
        db.add(Chunk(entry_id=entry_id, chunk_index=i, chunk_type="content", content=c))


def _create_qa_chunks(db: Session, entry_id: int, question: str, answer: str, title: str = "", chunk_size: int = 1500, chunk_overlap: int = 200) -> None:
    from app.import_.chunker import chunk_text

    idx = 0
    if title:
        db.add(Chunk(entry_id=entry_id, chunk_index=idx, chunk_type="title", content=title))
        idx += 1
    db.add(Chunk(entry_id=entry_id, chunk_index=idx, chunk_type="question", content=question))
    idx += 1
    answer_chunks = chunk_text(answer, max_chars=chunk_size, overlap_chars=chunk_overlap)
    if not answer_chunks:
        answer_chunks = [answer]
    for ac in answer_chunks:
        db.add(Chunk(entry_id=entry_id, chunk_index=idx, chunk_type="answer", content=ac))
        idx += 1


def _to_dict(entry: Entry, related: list | None = None) -> dict:
    d = {
        "id": entry.id,
        "entry_type": entry.entry_type,
        "title": entry.title,
        "display_title": entry.title or entry.question or "Ohne Titel",
        "question": entry.question,
        "answer": entry.answer,
        "content": entry.content,
        "source_filename": entry.source_filename,
        "tags": json.loads(entry.tags or "[]"),
        "created_at": entry.created_at.isoformat() if entry.created_at else None,
        "updated_at": entry.updated_at.isoformat() if entry.updated_at else None,
        "call_count": entry.call_count,
    }
    if related is not None:
        d["related"] = related
    return d


_VALID_ENTRY_TYPES = frozenset({"qa", "document"})
_VALID_SORT = frozenset({"updated", "calls"})


@router.get("")
def list_entries(
    page: int = 1,
    per_page: int = 20,
    tag: str | None = None,
    entry_type: str | None = None,
    sort: str = "updated",
    db: Session = Depends(get_db),
):
    if entry_type and entry_type not in _VALID_ENTRY_TYPES:
        raise HTTPException(400, f"Ungültiger entry_type. Erlaubt: {sorted(_VALID_ENTRY_TYPES)}")
    if sort not in _VALID_SORT:
        raise HTTPException(400, f"Ungültiger sort-Wert. Erlaubt: {sorted(_VALID_SORT)}")
    q = db.query(Entry)
    if entry_type:
        q = q.filter(Entry.entry_type == entry_type)
    if tag:
        q = q.join(EntryTag, Entry.id == EntryTag.entry_id).filter(EntryTag.tag == tag)
    total = q.count()
    order = Entry.call_count.desc() if sort == "calls" else Entry.updated_at.desc()
    items = q.order_by(order).offset((page - 1) * per_page).limit(per_page).all()
    return {"total": total, "page": page, "per_page": per_page, "items": [_to_dict(e) for e in items]}


@router.post("/check-duplicate")
def check_duplicate(payload: DupeCheckRequest, db: Session = Depends(get_db)):
    setting = db.query(Setting).filter(Setting.key == "dupe_threshold").first()
    threshold = json.loads(setting.value) if setting else DEFAULT_SETTINGS["dupe_threshold"]

    from app.search.meilisearch_client import search as ms_search
    text_to_check = f"{payload.question} {payload.answer}"
    
    hits = ms_search(
        query=text_to_check,
        threshold=threshold,
        top_k=5,
        entry_type="qa",
        hybrid=True
    )
    
    results = []
    for hit in hits:
        results.append({
            "id": hit["id"],
            "title": hit["title"],
            "question": hit["question"],
            "answer": hit.get("answer", ""),
            "score": hit["score"],
        })

    return results


@router.get("/{entry_id}")
def get_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found")

    entry.call_count += 1
    db.commit()

    related: list[dict] = []
    try:
        from app.search.meilisearch_client import search as ms_search
        query_text = entry.title or entry.question or entry.content or ""
        if len(query_text) > 10:
            hits = ms_search(
                query=query_text,
                threshold=0.2,
                top_k=5,
                hybrid=True
            )
            for hit in hits:
                if hit["id"] != entry_id:
                    related.append({
                        "id": hit["id"],
                        "entry_type": hit["entry_type"],
                        "title": hit["title"],
                        "display_title": hit.get("display_title"),
                        "question": hit["question"],
                        "tags": hit["tags"],
                    })
    except Exception:
        pass

    return _to_dict(entry, related=related)


@router.post("/document", status_code=201)
def create_document(payload: DocCreate, db: Session = Depends(get_db)):
    if not payload.content.strip():
        raise HTTPException(400, "Inhalt darf nicht leer sein")
    title_val = payload.title.strip()
    entry = Entry(
        entry_type="document",
        title=title_val,
        content=payload.content,
        source_filename=None,
        tags=json.dumps(payload.tags),
    )
    db.add(entry)
    db.flush()
    for tag in payload.tags:
        db.add(EntryTag(entry_id=entry.id, tag=tag))
    chunk_size = _get_setting(db, "chunk_size", 1500)
    chunk_overlap = _get_setting(db, "chunk_overlap", 200)
    _create_doc_chunks(db, entry.id, payload.content, chunk_size, chunk_overlap)
    _sync_fts(db, entry)
    db.commit()
    enqueue_entry_chunks(entry.id)
    return _to_dict(entry)


@router.post("", status_code=201)
def create_entry(payload: QACreate, db: Session = Depends(get_db)):
    title_val = payload.title.strip()
    entry = Entry(
        entry_type="qa",
        title=title_val,
        question=payload.question,
        answer=payload.answer,
        tags=json.dumps(payload.tags),
    )
    db.add(entry)
    db.flush()
    for tag in payload.tags:
        db.add(EntryTag(entry_id=entry.id, tag=tag))
    chunk_size = _get_setting(db, "chunk_size", 1500)
    chunk_overlap = _get_setting(db, "chunk_overlap", 200)
    _create_qa_chunks(db, entry.id, payload.question, payload.answer, title_val, chunk_size, chunk_overlap)
    _sync_fts(db, entry)
    db.commit()
    enqueue_entry_chunks(entry.id)
    return _to_dict(entry)


@router.put("/{entry_id}")
def update_entry(entry_id: int, payload: QAUpdate, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found")

    if payload.title is not None:
        entry.title = payload.title.strip()
    if payload.tags is not None:
        entry.tags = json.dumps(payload.tags)
        db.query(EntryTag).filter(EntryTag.entry_id == entry_id).delete()
        for tag in payload.tags:
            db.add(EntryTag(entry_id=entry_id, tag=tag))
    entry.updated_at = datetime.now(timezone.utc)

    chunk_size = _get_setting(db, "chunk_size", 1500)
    chunk_overlap = _get_setting(db, "chunk_overlap", 200)
    _delete_chunks_vec(db, entry_id)
    db.query(Chunk).filter(Chunk.entry_id == entry_id).delete()

    if entry.entry_type == "document":
        if payload.content is not None:
            entry.content = payload.content
        _create_doc_chunks(db, entry_id, entry.content or "", chunk_size, chunk_overlap)
    else:
        if payload.question is not None:
            entry.question = payload.question
        if payload.answer is not None:
            entry.answer = payload.answer
        _create_qa_chunks(db, entry_id, entry.question or "", entry.answer or "", entry.title or "", chunk_size, chunk_overlap)

    _sync_fts(db, entry)
    db.commit()
    enqueue_entry_chunks(entry.id)
    return _to_dict(entry)


@router.delete("/{entry_id}", status_code=204)
def delete_entry(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found")
    _delete_chunks_vec(db, entry_id)
    db.delete(entry)
    db.commit()
