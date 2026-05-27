import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.config import EMBEDDING_MODEL, EMBEDDING_DIM_OVERRIDE
from app.db.init_db import init_db, insert_seed_data
from app.db.session import get_db
from app.embeddings.model import load_model
from app.embeddings.queue import embedding_worker
from app.routers import entries, search, tags, import_, settings

logging.basicConfig(level=logging.INFO)

os.makedirs(os.getenv("UPLOAD_PATH", "./data/uploads"), exist_ok=True)


def _migrate_qa_chunks() -> None:
    """Migrate Q&A entries from single combined chunk to separate question/answer chunks."""
    from app.db.models import Chunk, Entry
    from app.db.session import SessionLocal
    from app.import_.chunker import chunk_text
    from sqlalchemy import text

    db = SessionLocal()
    try:
        old_chunks = (
            db.query(Chunk)
            .join(Entry, Chunk.entry_id == Entry.id)
            .filter(Entry.entry_type == "qa", Chunk.chunk_type == "content")
            .all()
        )
        entry_ids = list({c.entry_id for c in old_chunks})
        if not entry_ids:
            return

        logging.info(f"Startup: migrating {len(entry_ids)} Q&A entries to separate question/answer chunks")

        for entry_id in entry_ids:
            entry = db.query(Entry).filter(Entry.id == entry_id).first()
            if not entry:
                continue
            old = db.query(Chunk).filter(Chunk.entry_id == entry_id).all()
            for c in old:
                try:
                    db.execute(text("DELETE FROM chunks_vec WHERE rowid = :id"), {"id": c.id})
                except Exception:
                    pass
                db.delete(c)
            db.flush()

            db.add(Chunk(entry_id=entry_id, chunk_index=0, chunk_type="question", content=entry.question or ""))
            answer_chunks = chunk_text(entry.answer or "")
            if not answer_chunks:
                answer_chunks = [entry.answer or ""]
            for i, ac in enumerate(answer_chunks):
                db.add(Chunk(entry_id=entry_id, chunk_index=i + 1, chunk_type="answer", content=ac))

        db.commit()
        logging.info(f"Startup: Q&A migration complete for {len(entry_ids)} entries (embeddings queued by _enqueue_missing_embeddings)")
    finally:
        db.close()


def _enqueue_missing_embeddings() -> None:
    """Queue every chunk that has no entry in chunks_vec yet."""
    from app.db.models import Chunk
    from app.db.session import SessionLocal
    from app.embeddings.queue import enqueue_chunk
    from sqlalchemy import text

    db = SessionLocal()
    try:
        all_ids = [row[0] for row in db.query(Chunk.id).all()]
        if not all_ids:
            return
        placeholders = ",".join(str(i) for i in all_ids)
        already = {
            row[0]
            for row in db.execute(
                text(f"SELECT rowid FROM chunks_vec WHERE rowid IN ({placeholders})")
            ).fetchall()
        }
        missing = [i for i in all_ids if i not in already]
        for cid in missing:
            enqueue_chunk(cid)
        if missing:
            logging.info(f"Startup: enqueued {len(missing)} chunk(s) missing embeddings")
    finally:
        db.close()


def _resolve_embedding_dim() -> int:
    if EMBEDDING_DIM_OVERRIDE is not None:
        logging.info(f"Embedding dimension: {EMBEDDING_DIM_OVERRIDE} (from EMBEDDING_DIM env var)")
        return EMBEDDING_DIM_OVERRIDE
    from app.embeddings.model import get_model
    test = list(get_model().embed(["x"]))[0]
    dim = int(len(test))
    logging.info(f"Embedding dimension: {dim} (auto-detected from {EMBEDDING_MODEL})")
    return dim


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_model()
    dim = _resolve_embedding_dim()
    init_db(embedding_dim=dim)
    insert_seed_data()
    _migrate_qa_chunks()
    _enqueue_missing_embeddings()
    task = asyncio.create_task(embedding_worker())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Semnia", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(entries.router)
app.include_router(search.router)
app.include_router(tags.router)
app.include_router(import_.router)
app.include_router(settings.router)


@app.get("/api/status")
async def api_status(db: Session = Depends(get_db)):
    import httpx
    from sqlalchemy import text
    from app.db.models import Entry, Chunk, Setting
    from app.embeddings.model import get_model

    entry_count = db.query(Entry).count()
    chunk_count = db.query(Chunk).count()

    # Unembedded chunks
    unembedded = 0
    if chunk_count:
        try:
            all_ids = [r[0] for r in db.query(Chunk.id).all()]
            placeholders = ",".join(str(i) for i in all_ids)
            embedded = db.execute(
                text(f"SELECT COUNT(*) FROM chunks_vec WHERE rowid IN ({placeholders})")
            ).scalar() or 0
            unembedded = chunk_count - embedded
        except Exception:
            unembedded = 0

    # DB file size
    db_size_bytes = 0
    try:
        db_size_bytes = os.path.getsize(os.getenv("DB_PATH", "./data/wissensdatenbank.sqlite"))
    except OSError:
        pass

    ollama_setting = db.query(Setting).filter(Setting.key == "ollama_url").first()
    ollama_url = json.loads(ollama_setting.value) if ollama_setting else ""
    ollama_configured = bool(ollama_url and ollama_url.strip())

    ollama_model_setting = db.query(Setting).filter(Setting.key == "ollama_model").first()
    ollama_model = json.loads(ollama_model_setting.value) if ollama_model_setting else ""

    ollama_ready = False
    if ollama_configured:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                r = await client.get(f"{ollama_url}/api/tags")
                ollama_ready = r.status_code == 200
        except Exception:
            pass

    return {
        "entry_count": entry_count,
        "chunk_count": chunk_count,
        "unembedded_chunks": unembedded,
        "db_size_bytes": db_size_bytes,
        "model": EMBEDDING_MODEL,
        "model_ready": get_model() is not None,
        "ollama_configured": ollama_configured,
        "ollama_ready": ollama_ready,
        "ollama_model": ollama_model,
    }


# ── Static frontend (only active when FRONTEND_DIR is set) ───────────────────

_FRONTEND_DIR = os.getenv("FRONTEND_DIR", "")

if _FRONTEND_DIR and os.path.isdir(_FRONTEND_DIR):
    _custom = os.getenv("CUSTOM_PATH", "/custom")
    if os.path.isdir(_custom):
        app.mount("/custom", StaticFiles(directory=_custom), name="custom")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_frontend(full_path: str):
        if full_path:
            candidate = os.path.join(_FRONTEND_DIR, full_path)
            if os.path.isfile(candidate):
                headers = (
                    {"Cache-Control": "public, max-age=604800, immutable"}
                    if "/assets/" in candidate
                    else {}
                )
                return FileResponse(candidate, headers=headers)
        return FileResponse(
            os.path.join(_FRONTEND_DIR, "index.html"),
            headers={"Cache-Control": "no-cache, no-store"},
        )
