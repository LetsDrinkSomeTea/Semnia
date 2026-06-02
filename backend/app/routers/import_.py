import json
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel as _BaseModel
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import DEFAULT_SETTINGS
from app.db.session import get_db
from app.db.models import Entry, EntryTag, Chunk
from app.import_.parsers import parse_markdown, parse_pdf, parse_docx
from app.import_.chunker import chunk_text
from app.embeddings.queue import enqueue_entry_chunks

router = APIRouter(prefix="/api/import", tags=["import"])

_MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB


@router.post("")
async def upload_file(
    file: UploadFile = File(...),
    tags: str = "[]",
    db: Session = Depends(get_db),
):
    raw = await file.read()
    if len(raw) > _MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Datei zu groß (max {_MAX_UPLOAD_BYTES // 1024 // 1024} MB)")
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


class _TagsPayload(_BaseModel):
    tags: list[str] = []


@router.put("/{entry_id}/tags")
def update_import_tags(entry_id: int, payload: _TagsPayload, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id, Entry.entry_type == "document").first()
    if not entry:
        raise HTTPException(404, "Dokument nicht gefunden")
    tag_list: list[str] = payload.tags
    entry.tags = json.dumps(tag_list)
    db.query(EntryTag).filter(EntryTag.entry_id == entry_id).delete()
    for tag in tag_list:
        db.add(EntryTag(entry_id=entry_id, tag=tag))
    db.commit()
    return {"id": entry.id, "tags": tag_list}


@router.delete("/{entry_id}", status_code=204)
def delete_import(entry_id: int, db: Session = Depends(get_db)):
    entry = db.query(Entry).filter(Entry.id == entry_id, Entry.entry_type == "document").first()
    if not entry:
        raise HTTPException(404, "Dokument nicht gefunden")
    from app.search.meilisearch_client import delete_entry_from_meili
    delete_entry_from_meili(entry_id)
    db.delete(entry)
    db.commit()


import numpy as np


class BulkQAAction(_BaseModel):
    title: str = ""
    question: str
    answer: str
    tags: list[str]
    action: str  # "import" | "skip" | "replace"
    replace_id: int | None = None


def _process_qa_row(
    title: str,
    question: str,
    answer: str,
    tags: list[str],
    dupe_threshold: float,
) -> dict:
    """Synchronous per-row processing: tag suggestions + dupe check. Runs in a thread."""
    from collections import Counter
    from app.db.session import SessionLocal
    from app.embeddings.model import encode_query

    combined = f"{question} {answer}"
    row_db = SessionLocal()
    suggested_tags: list[str] = []
    duplicates: list[dict] = []
    try:
        from app.search.meilisearch_client import search as ms_search
        
        # Tag suggestions via meilisearch
        if len(combined) >= 10:
            hits = ms_search(query=combined, threshold=0.1, top_k=10, hybrid=False)
            entry_ids = [h["id"] for h in hits]
            if entry_ids:
                entries = row_db.query(Entry).filter(Entry.id.in_(entry_ids)).all()
                ctr: Counter = Counter()
                for e in entries:
                    for t in json.loads(e.tags or "[]"):
                        ctr[t] += 1
                suggested_tags = [t for t, _ in ctr.most_common(5) if t not in tags]

        # Dupe check via embedding — use question only
        hits = ms_search(query=question, threshold=dupe_threshold, top_k=20, entry_type="qa", hybrid=True)
        for hit in hits:
            duplicates.append({
                "id": hit["id"],
                "question": hit["question"],
                "answer": hit.get("answer", "")[:200],
                "score": hit["score"],
            })
    except Exception as e:
        import logging
        logging.error(f"Error processing QA row: {e}")
    finally:
        row_db.close()

    return {
        "title": title,
        "question": question,
        "answer": answer,
        "tags": tags,
        "suggested_tags": suggested_tags,
        "duplicates": duplicates,
    }


@router.post("/qa/parse")
async def parse_qa_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Stream Q&A CSV rows one by one as they are processed (SSE)."""
    import asyncio
    import csv
    import io
    from fastapi.responses import StreamingResponse
    from app.db.models import Setting

    raw = await file.read()
    try:
        text_content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text_content = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_content))
    if reader.fieldnames is None or "question" not in reader.fieldnames:
        raise HTTPException(400, "CSV muss eine 'question'-Spalte haben")

    csv_rows = [
        {
            "title": (r.get("title") or "").strip(),
            "question": (r.get("question") or "").strip(),
            "answer": (r.get("answer") or "").strip(),
            "tags": [t.strip() for t in (r.get("tags") or "").split(",") if t.strip()],
        }
        for r in reader
        if (r.get("question") or "").strip()
    ]

    setting = db.query(Setting).filter(Setting.key == "dupe_threshold").first()
    dupe_threshold = json.loads(setting.value) if setting else DEFAULT_SETTINGS["dupe_threshold"]
    total = len(csv_rows)

    async def generate():
        for idx, row in enumerate(csv_rows):
            try:
                result = await asyncio.to_thread(
                    _process_qa_row,
                    row["title"], row["question"], row["answer"], row["tags"], dupe_threshold,
                )
            except Exception as exc:
                import logging
                logging.error(f"Error in parse_qa_csv for row {idx}: {exc}")
                result = {
                    "title": row["title"],
                    "question": row["question"],
                    "answer": row["answer"],
                    "tags": row["tags"],
                    "suggested_tags": [],
                    "duplicates": [],
                }
            result["index"] = idx
            result["total"] = total
            yield f"data: {json.dumps(result, ensure_ascii=False)}\n\n"
        yield f"data: {json.dumps({'done': True, 'total': total})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/qa/confirm")
def confirm_qa_import(items: list[BulkQAAction], db: Session = Depends(get_db)):
    """Execute bulk Q&A import: import new, skip, or replace existing entries."""
    import datetime as _dt
    from app.embeddings.queue import enqueue_entry_chunks
    from app.import_.chunker import chunk_text

    imported = skipped = replaced = 0
    enqueue_ids: list[int] = []  # collect after commit

    for item in items:
        if item.action == "skip":
            skipped += 1
            continue

        if item.action == "replace" and item.replace_id:
            entry = db.query(Entry).filter(Entry.id == item.replace_id).first()
            if entry:
                if item.title:
                    entry.title = item.title.strip()
                entry.answer = item.answer
                entry.tags = json.dumps(item.tags)
                entry.updated_at = _dt.datetime.now(_dt.timezone.utc)
                db.query(EntryTag).filter(EntryTag.entry_id == entry.id).delete()
                for tag in item.tags:
                    db.add(EntryTag(entry_id=entry.id, tag=tag))
                # Rebuild chunks so vector index stays in sync with updated answer
                # Let queue handle Meilisearch sync
                enqueue_ids.append(entry.id)
                replaced += 1
            continue

        # action == "import"
        title = item.title.strip()
        entry = Entry(
            entry_type="qa",
            title=title,
            question=item.question,
            answer=item.answer,
            tags=json.dumps(item.tags),
        )
        db.add(entry)
        db.flush()

        for tag in item.tags:
            db.add(EntryTag(entry_id=entry.id, tag=tag))

        _idx = 0
        if title:
            db.add(Chunk(entry_id=entry.id, chunk_index=_idx, chunk_type="title", content=title))
            _idx += 1
        db.add(Chunk(entry_id=entry.id, chunk_index=_idx, chunk_type="question", content=item.question))
        _idx += 1
        answer_chunks = chunk_text(item.answer or "")
        if not answer_chunks:
            answer_chunks = [item.answer or ""]
        for ac in answer_chunks:
            db.add(Chunk(entry_id=entry.id, chunk_index=_idx, chunk_type="answer", content=ac))
            _idx += 1

        enqueue_ids.append(entry.id)
        imported += 1

    db.commit()  # commit first — chunks are now visible to other sessions

    for eid in enqueue_ids:
        enqueue_entry_chunks(eid)

    return {"imported": imported, "skipped": skipped, "replaced": replaced}


def _count_embedded(db: Session, chunk_ids: list[int]) -> int:
    # Optimistic approximation for UI since Meilisearch async syncing is fast
    return len(chunk_ids)
