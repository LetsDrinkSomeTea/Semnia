import json
import asyncio
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import Setting, Entry
from app.embeddings.queue import enqueue_entry_chunks
from app.config import DEFAULT_SETTINGS

router = APIRouter(prefix="/api/settings", tags=["settings"])

_ALLOWED_SETTINGS_KEYS = frozenset(DEFAULT_SETTINGS.keys())


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
    unknown = [k for k in payload if k not in _ALLOWED_SETTINGS_KEYS]
    if unknown:
        raise HTTPException(400, f"Unbekannte Einstellungsschlüssel: {unknown}")
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


