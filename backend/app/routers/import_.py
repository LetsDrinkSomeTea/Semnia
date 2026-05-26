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


from pydantic import BaseModel as _BaseModel
import numpy as np


class BulkQAAction(_BaseModel):
    question: str
    answer: str
    tags: list[str]
    action: str  # "import" | "skip" | "replace"
    replace_id: int | None = None


@router.post("/qa/parse")
async def parse_qa_csv(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Parse a Q&A CSV file and return rows with dupe check + tag suggestions."""
    import csv
    import io
    from app.db.models import Setting
    from app.embeddings.model import encode_query, to_bytes
    from app.search.bm25 import fts_search

    raw = await file.read()
    try:
        text_content = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text_content = raw.decode("latin-1")

    reader = csv.DictReader(io.StringIO(text_content))
    if reader.fieldnames is None or "question" not in reader.fieldnames:
        raise HTTPException(400, "CSV muss eine 'question'-Spalte haben")

    setting = db.query(Setting).filter(Setting.key == "dupe_threshold").first()
    dupe_threshold = json.loads(setting.value) if setting else 0.92

    rows = []
    for csv_row in reader:
        question = (csv_row.get("question") or "").strip()
        answer = (csv_row.get("answer") or "").strip()
        tags_raw = (csv_row.get("tags") or "").strip()
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]

        if not question:
            continue

        # Tag suggestions via BM25 on existing entries
        suggested_tags: list[str] = []
        combined = f"{question} {answer}"
        if len(combined) >= 10:
            from collections import Counter
            hits = fts_search(db, combined, top_k=10)
            entry_ids = [eid for eid, _ in hits]
            if entry_ids:
                entries = db.query(Entry).filter(Entry.id.in_(entry_ids)).all()
                ctr: Counter = Counter()
                for e in entries:
                    for t in json.loads(e.tags or "[]"):
                        ctr[t] += 1
                suggested_tags = [t for t, _ in ctr.most_common(5) if t not in tags]

        # Duplicate check via embedding
        duplicates: list[dict] = []
        try:
            emb_bytes = to_bytes(encode_query(combined))
            vec_rows = db.execute(
                text("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH :emb ORDER BY distance LIMIT 20"),
                {"emb": emb_bytes},
            ).fetchall()
            chunk_ids = [int(r[0]) for r in vec_rows]
            chunk_to_entry = {
                c.id: c.entry_id
                for c in db.query(Chunk).filter(Chunk.id.in_(chunk_ids)).all()
            } if chunk_ids else {}

            seen: set[int] = set()
            for rowid, distance in vec_rows:
                entry_id = chunk_to_entry.get(int(rowid))
                if not entry_id or entry_id in seen:
                    continue
                cosine_sim = float(np.clip(1.0 - (distance ** 2) / 2.0, 0.0, 1.0))
                if cosine_sim >= dupe_threshold:
                    e = db.query(Entry).filter(Entry.id == entry_id).first()
                    if e and e.entry_type == "qa":
                        seen.add(entry_id)
                        duplicates.append({
                            "id": e.id,
                            "question": e.question,
                            "answer": (e.answer or "")[:200],
                            "score": round(cosine_sim, 4),
                        })
        except Exception:
            pass

        rows.append({
            "question": question,
            "answer": answer,
            "tags": tags,
            "suggested_tags": suggested_tags,
            "duplicates": duplicates,
        })

    return {"rows": rows, "total": len(rows)}


@router.post("/qa/confirm")
def confirm_qa_import(items: list[BulkQAAction], db: Session = Depends(get_db)):
    """Execute bulk Q&A import: import new, skip, or replace existing entries."""
    import datetime
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
                entry.answer = item.answer
                entry.tags = json.dumps(item.tags)
                entry.updated_at = datetime.datetime.utcnow()
                db.query(EntryTag).filter(EntryTag.entry_id == entry.id).delete()
                for tag in item.tags:
                    db.add(EntryTag(entry_id=entry.id, tag=tag))
                db.execute(
                    text("UPDATE entries_fts SET answer = :a WHERE rowid = :id"),
                    {"a": entry.answer, "id": entry.id},
                )
                enqueue_ids.append(entry.id)
                replaced += 1
            continue

        # action == "import"
        title = item.question[:120]
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

        db.add(Chunk(entry_id=entry.id, chunk_index=0, chunk_type="question", content=item.question))
        answer_chunks = chunk_text(item.answer or "")
        if not answer_chunks:
            answer_chunks = [item.answer or ""]
        for i, ac in enumerate(answer_chunks):
            db.add(Chunk(entry_id=entry.id, chunk_index=i + 1, chunk_type="answer", content=ac))

        db.execute(
            text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id,:t,:q,:a,'')"),
            {"id": entry.id, "t": title, "q": item.question, "a": item.answer},
        )
        enqueue_ids.append(entry.id)
        imported += 1

    db.commit()  # commit first — chunks are now visible to other sessions

    for eid in enqueue_ids:
        enqueue_entry_chunks(eid)

    return {"imported": imported, "skipped": skipped, "replaced": replaced}


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
