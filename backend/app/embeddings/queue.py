import asyncio
import logging
from sqlalchemy import text
from app.db.session import SessionLocal
from app.db.models import Chunk, Entry
from app.embeddings.model import encode_passage

logger = logging.getLogger(__name__)
_queue: asyncio.Queue[int] = asyncio.Queue()


def enqueue_chunk(chunk_id: int) -> None:
    _queue.put_nowait(chunk_id)


def enqueue_entry_chunks(entry_id: int) -> None:
    """Enqueue all chunks for an entry (call after creating/updating entry)."""
    db = SessionLocal()
    try:
        chunk_ids = [c.id for c in db.query(Chunk.id).filter(Chunk.entry_id == entry_id).all()]
        for cid in chunk_ids:
            _queue.put_nowait(cid)
    finally:
        db.close()


async def embedding_worker() -> None:
    logger.info("Embedding worker started")
    while True:
        chunk_id = await _queue.get()
        try:
            await asyncio.to_thread(_embed_chunk, chunk_id)
        except Exception as exc:
            logger.error(f"Failed to embed chunk {chunk_id}: {exc}")
        finally:
            _queue.task_done()


def _embed_chunk(chunk_id: int) -> None:
    db = SessionLocal()
    try:
        chunk = db.query(Chunk).filter(Chunk.id == chunk_id).first()
        if not chunk or not chunk.content.strip():
            return
            
        entry = db.query(Entry).filter(Entry.id == chunk.entry_id).first()
        if not entry:
            return
            
        emb = encode_passage(chunk.content)
        
        from app.search.meilisearch_client import upsert_chunk
        upsert_chunk(entry, chunk, emb.tolist())
        
        logger.info(f"Embedded and synced chunk {chunk_id} to Meilisearch (entry {chunk.entry_id})")
    finally:
        db.close()
