import json
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.db.models import Entry, EntryTag, Chunk
from app.import_.parsers import parse_markdown, parse_pdf, parse_docx
from app.import_.chunker import chunk_text
from app.embeddings.queue import enqueue_entry_chunks

router = APIRouter(prefix="/api/import", tags=["import"])


@router.post("")
async def upload_file(
    file: UploadFile = File(...),
    tags: str = "[]",
    db: Session = Depends(get_db),
):
    raw = await file.read()
    filename = file.filename or "unknown"
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""

    if ext == "md":
        text_content = parse_markdown(raw)
    elif ext == "pdf":
        try:
            text_content = parse_pdf(raw)
        except Exception as e:
            raise HTTPException(400, f"PDF-Fehler: {e}")
    elif ext in ("docx", "doc"):
        try:
            text_content = parse_docx(raw)
        except Exception as e:
            raise HTTPException(400, f"DOCX-Fehler: {e}")
    else:
        raise HTTPException(400, f"Nicht unterstütztes Format: .{ext}")

    if not text_content or not text_content.strip():
        raise HTTPException(400, "Kein Inhalt extrahierbar")

    chunks = chunk_text(text_content)
    if not chunks:
        raise HTTPException(400, "Kein Inhalt extrahierbar")

    # Derive title from first heading or filename
    first_line = text_content.strip().split("\n")[0].lstrip("#").strip()
    title = first_line if 10 < len(first_line) < 120 else filename.rsplit(".", 1)[0]

    try:
        tag_list: list[str] = json.loads(tags)
    except Exception:
        tag_list = []

    entry = Entry(
        entry_type="document",
        title=title,
        content=text_content,
        source_filename=filename,
        tags=json.dumps(tag_list),
    )
    db.add(entry)
    db.flush()

    for tag in tag_list:
        db.add(EntryTag(entry_id=entry.id, tag=tag))

    for i, chunk_content in enumerate(chunks):
        db.add(Chunk(entry_id=entry.id, chunk_index=i, content=chunk_content))

    db.execute(
        text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,'','',:c)"),
        {"id": entry.id, "t": title, "c": text_content},
    )
    db.commit()
    enqueue_entry_chunks(entry.id)

    return {"entry_id": entry.id, "title": title, "chunk_count": len(chunks)}


@router.get("")
def list_imports(page: int = 1, per_page: int = 20, db: Session = Depends(get_db)):
    q = db.query(Entry).filter(Entry.entry_type == "document").order_by(Entry.created_at.desc())
    total = q.count()
    entries = q.offset((page - 1) * per_page).limit(per_page).all()

    results = []
    for entry in entries:
        chunk_ids = [c.id for c in db.query(Chunk).filter(Chunk.entry_id == entry.id).all()]
        embedded = _count_embedded(db, chunk_ids)
        results.append({
            "id": entry.id,
            "title": entry.title,
            "source_filename": entry.source_filename,
            "tags": json.loads(entry.tags or "[]"),
            "created_at": entry.created_at.isoformat() if entry.created_at else None,
            "chunk_count": len(chunk_ids),
            "embedded_count": embedded,
        })

    return {"total": total, "page": page, "per_page": per_page, "items": results}


@router.get("/{entry_id}/status")
def import_status(entry_id: int, db: Session = Depends(get_db)):
    chunk_ids = [c.id for c in db.query(Chunk).filter(Chunk.entry_id == entry_id).all()]
    if not chunk_ids:
        return {"chunk_count": 0, "embedded_count": 0, "done": True}
    embedded = _count_embedded(db, chunk_ids)
    return {
        "chunk_count": len(chunk_ids),
        "embedded_count": embedded,
        "done": embedded >= len(chunk_ids),
    }


@router.put("/{entry_id}/tags")
def update_import_tags(entry_id: int, payload: dict, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id, Entry.entry_type == "document").first()
    if not entry:
        raise HTTPException(404, "Dokument nicht gefunden")
    tag_list: list[str] = payload.get("tags", [])
    entry.tags = json.dumps(tag_list)
    db.query(EntryTag).filter(EntryTag.entry_id == entry_id).delete()
    for tag in tag_list:
        db.add(EntryTag(entry_id=entry_id, tag=tag))
    db.execute(
        text("UPDATE entries_fts SET title = :t WHERE rowid = :id"),
        {"t": entry.title, "id": entry_id},
    )
    db.commit()
    return {"id": entry.id, "tags": tag_list}


@router.delete("/{entry_id}", status_code=204)
def delete_import(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id, Entry.entry_type == "document").first()
    if not entry:
        raise HTTPException(404, "Dokument nicht gefunden")
    chunk_ids = [c.id for c in db.query(Chunk).filter(Chunk.entry_id == entry_id).all()]
    for cid in chunk_ids:
        try:
            db.execute(text("DELETE FROM chunks_vec WHERE rowid = :id"), {"id": cid})
        except Exception:
            pass
    db.execute(text("DELETE FROM entries_fts WHERE rowid = :id"), {"id": entry_id})
    db.delete(entry)
    db.commit()


def _count_embedded(db: Session, chunk_ids: list[int]) -> int:
    if not chunk_ids:
        return 0
    count = 0
    for cid in chunk_ids:
        try:
            row = db.execute(
                text("SELECT rowid FROM chunks_vec WHERE rowid = :id"), {"id": cid}
            ).fetchone()
            if row:
                count += 1
        except Exception:
            pass
    return count
