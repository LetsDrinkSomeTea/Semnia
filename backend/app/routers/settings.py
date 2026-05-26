import json
import asyncio
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import Setting, Entry, EntryTag, Chunk
from app.embeddings.queue import enqueue_entry_chunks
from app.config import DEFAULT_SETTINGS

router = APIRouter(prefix="/api/settings", tags=["settings"])


def _load_all(db: Session) -> dict:
    result = dict(DEFAULT_SETTINGS)
    for row in db.query(Setting).all():
        try:
            result[row.key] = json.loads(row.value)
        except Exception:
            result[row.key] = row.value
    return result


@router.get("")
def get_settings(db: Session = Depends(get_db)):
    return _load_all(db)


@router.put("")
def update_settings(payload: dict, db: Session = Depends(get_db)):
    for key, value in payload.items():
        existing = db.query(Setting).filter(Setting.key == key).first()
        if existing:
            existing.value = json.dumps(value)
        else:
            db.add(Setting(key=key, value=json.dumps(value)))
    db.commit()
    return _load_all(db)


@router.post("/reindex")
def reindex(db: Session = Depends(get_db)):
    entry_ids = [row[0] for row in db.query(Entry.id).all()]

    async def stream():
        total = len(entry_ids)
        for i, eid in enumerate(entry_ids, 1):
            enqueue_entry_chunks(eid)
            await asyncio.sleep(0.02)
            yield f"data: {json.dumps({'done': i, 'total': total, 'entry_id': eid})}\n\n"
        yield f"data: {json.dumps({'done': total, 'total': total, 'complete': True})}\n\n"

    return StreamingResponse(stream(), media_type="text/event-stream")


@router.post("/reset")
def reset_data(db: Session = Depends(get_db)):
    # Collect chunk IDs before deletion for chunks_vec cleanup
    chunk_ids = [c.id for c in db.query(Chunk).all()]

    db.execute(text("DELETE FROM entries_fts"))
    for cid in chunk_ids:
        try:
            db.execute(text("DELETE FROM chunks_vec WHERE rowid = :id"), {"id": cid})
        except Exception:
            pass

    db.query(Entry).delete(synchronize_session=False)
    db.commit()

    from app.db.init_db import insert_seed_data
    insert_seed_data()

    entry_ids = [row[0] for row in db.query(Entry.id).all()]
    for eid in entry_ids:
        enqueue_entry_chunks(eid)

    return {"reset": True, "seed_count": len(entry_ids)}
