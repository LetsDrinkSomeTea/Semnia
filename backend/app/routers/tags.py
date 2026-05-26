from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import EntryTag

router = APIRouter(prefix="/api/tags", tags=["tags"])


@router.get("")
def list_tags(db: Session = Depends(get_db)):
    rows = (
        db.query(EntryTag.tag, func.count(EntryTag.entry_id).label("count"))
        .group_by(EntryTag.tag)
        .order_by(func.count(EntryTag.entry_id).desc())
        .all()
    )
    return [{"name": row.tag, "count": row.count} for row in rows]
