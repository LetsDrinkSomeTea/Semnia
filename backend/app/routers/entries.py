import json
import numpy as np
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session
from pydantic import BaseModel

from app.db.session import get_db
from app.db.models import Entry, EntryTag, Chunk, Setting
from app.embeddings.queue import enqueue_entry_chunks

router = APIRouter(prefix="/api/entries", tags=["entries"])


class QACreate(BaseModel):
    question: str
    answer: str
    tags: list[str] = []


class QAUpdate(BaseModel):
    question: str | None = None
    answer: str | None = None
    tags: list[str] | None = None


class DupeCheckRequest(BaseModel):
    question: str
    answer: str


def _sync_fts(db: Session, entry: Entry) -> None:
    db.execute(text("DELETE FROM entries_fts WHERE rowid = :id"), {"id": entry.id})
    db.execute(
        text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,:c)"),
        {
            "id": entry.id,
            "t": entry.title or "",
            "q": entry.question or "",
            "a": entry.answer or "",
            "c": entry.content or "",
        },
    )


def _delete_chunks_vec(db: Session, entry_id: int) -> None:
    chunk_ids = [c.id for c in db.query(Chunk).filter(Chunk.entry_id == entry_id).all()]
    for cid in chunk_ids:
        try:
            db.execute(text("DELETE FROM chunks_vec WHERE rowid = :id"), {"id": cid})
        except Exception:
            pass


def _to_dict(entry: Entry, related: list | None = None) -> dict:
    d = {
        "id": entry.id,
        "entry_type": entry.entry_type,
        "title": entry.title,
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


@router.get("")
def list_entries(
    page: int = 1,
    per_page: int = 20,
    tag: str | None = None,
    entry_type: str | None = None,
    sort: str = "updated",
    db: Session = Depends(get_db),
):
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
    from app.embeddings.model import encode_query, to_bytes

    text_to_check = f"{payload.question} {payload.answer}"
    emb_bytes = to_bytes(encode_query(text_to_check))

    setting = db.query(Setting).filter(Setting.key == "dupe_threshold").first()
    threshold = json.loads(setting.value) if setting else 0.92

    try:
        rows = db.execute(
            text("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH :emb ORDER BY distance LIMIT 20"),
            {"emb": emb_bytes},
        ).fetchall()
    except Exception:
        return []

    if not rows:
        return []

    chunk_ids = [int(r[0]) for r in rows]
    chunk_to_entry = {c.id: c.entry_id for c in db.query(Chunk).filter(Chunk.id.in_(chunk_ids)).all()}

    seen: set[int] = set()
    results = []
    for rowid, distance in rows:
        entry_id = chunk_to_entry.get(int(rowid))
        if entry_id is None or entry_id in seen:
            continue
        cosine_sim = float(np.clip(1.0 - (distance ** 2) / 2.0, 0.0, 1.0))
        if cosine_sim >= threshold:
            entry = db.query(Entry).filter(Entry.id == entry_id).first()
            if entry and entry.entry_type == "qa":
                seen.add(entry_id)
                results.append({
                    "id": entry.id,
                    "title": entry.title,
                    "question": entry.question,
                    "score": round(cosine_sim, 4),
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
        first_chunk = db.query(Chunk).filter(Chunk.entry_id == entry_id).first()
        if first_chunk:
            vec_row = db.execute(
                text("SELECT embedding FROM chunks_vec WHERE rowid = :id"), {"id": first_chunk.id}
            ).fetchone()
            if vec_row:
                rows = db.execute(
                    text("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH :emb ORDER BY distance LIMIT 25"),
                    {"emb": vec_row[0]},
                ).fetchall()
                chunk_ids = [int(r[0]) for r in rows]
                chunk_to_entry = {
                    c.id: c.entry_id
                    for c in db.query(Chunk).filter(Chunk.id.in_(chunk_ids)).all()
                }
                seen: set[int] = set()
                rel_ids: list[int] = []
                for chunk_id in chunk_ids:
                    eid = chunk_to_entry.get(chunk_id)
                    if eid and eid != entry_id and eid not in seen:
                        seen.add(eid)
                        rel_ids.append(eid)
                    if len(rel_ids) >= 5:
                        break
                if rel_ids:
                    rel_entries = db.query(Entry).filter(Entry.id.in_(rel_ids)).all()
                    related = [
                        {
                            "id": e.id,
                            "entry_type": e.entry_type,
                            "title": e.title,
                            "tags": json.loads(e.tags or "[]"),
                        }
                        for e in rel_entries
                    ]
    except Exception:
        pass

    return _to_dict(entry, related=related)


@router.post("", status_code=201)
def create_entry(payload: QACreate, db: Session = Depends(get_db)):
    entry = Entry(
        entry_type="qa",
        title=payload.question[:120],
        question=payload.question,
        answer=payload.answer,
        tags=json.dumps(payload.tags),
    )
    db.add(entry)
    db.flush()
    for tag in payload.tags:
        db.add(EntryTag(entry_id=entry.id, tag=tag))
    db.add(Chunk(
        entry_id=entry.id,
        chunk_index=0,
        content=f"{payload.question} {payload.answer}",
    ))
    _sync_fts(db, entry)
    db.commit()
    enqueue_entry_chunks(entry.id)
    return _to_dict(entry)


@router.put("/{entry_id}")
def update_entry(entry_id: int, payload: QAUpdate, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id).first()
    if not entry:
        raise HTTPException(404, "Entry not found")
    if payload.question is not None:
        entry.question = payload.question
        entry.title = payload.question[:120]
    if payload.answer is not None:
        entry.answer = payload.answer
    if payload.tags is not None:
        entry.tags = json.dumps(payload.tags)
        db.query(EntryTag).filter(EntryTag.entry_id == entry_id).delete()
        for tag in payload.tags:
            db.add(EntryTag(entry_id=entry_id, tag=tag))
    entry.updated_at = datetime.utcnow()

    chunk = db.query(Chunk).filter(Chunk.entry_id == entry_id, Chunk.chunk_index == 0).first()
    new_content = f"{entry.question} {entry.answer}"
    if chunk:
        chunk.content = new_content
    else:
        db.add(Chunk(entry_id=entry_id, chunk_index=0, content=new_content))

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
    db.execute(text("DELETE FROM entries_fts WHERE rowid = :id"), {"id": entry_id})
    db.delete(entry)
    db.commit()
