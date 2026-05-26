import json
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.db.models import ImportQueue, Entry, EntryTag
from app.import_.chunker import suggest_title
from app.embeddings.queue import enqueue


def create_queue_items(db: Session, filename: str, chunks: list[str]) -> list[ImportQueue]:
    items = []
    for i, chunk in enumerate(chunks):
        title = suggest_title(chunk, filename, i)
        item = ImportQueue(
            source_filename=filename,
            chunk_index=i,
            raw_content=chunk,
            suggested_title=title,
        )
        db.add(item)
        items.append(item)
    db.commit()
    return items


def approve_item(
    db: Session,
    item_id: int,
    title: str | None = None,
    tags: list[str] | None = None,
) -> Entry:
    item = db.query(ImportQueue).filter(ImportQueue.id == item_id).first()
    if not item:
        raise ValueError("Queue item not found")

    used_title = (title or item.suggested_title or item.source_filename)[:120]
    used_tags = tags if tags is not None else json.loads(item.tags or "[]")

    entry = Entry(
        entry_type="document",
        title=used_title,
        content=item.raw_content,
        source_filename=item.source_filename,
        tags=json.dumps(used_tags),
    )
    db.add(entry)
    db.flush()

    for tag in used_tags:
        db.add(EntryTag(entry_id=entry.id, tag=tag))

    db.execute(
        text("INSERT INTO entries_fts(rowid, title, question, answer, content) VALUES (:id, :t, '', '', :c)"),
        {"id": entry.id, "t": used_title, "c": item.raw_content},
    )

    item.status = "approved"
    db.commit()
    enqueue(entry.id)
    return entry
