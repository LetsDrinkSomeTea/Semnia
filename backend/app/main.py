import asyncio
import json
import logging
import os
import time
import sqlalchemy
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from app.config import EMBEDDING_MODEL, EMBEDDING_DIM_OVERRIDE, TZ, SSL_VERIFY
from app.db.init_db import init_db, insert_seed_data
from app.db.session import get_db
from app.embeddings.model import load_model
from app.embeddings.queue import embedding_worker
from app.routers import entries, search, tags, import_, settings

os.environ["TZ"] = TZ
time.tzset()

if not SSL_VERIFY:
    import ssl
    import urllib3
    # Patch Python's global SSL context — affects urllib, requests, httpx, and any
    # library that doesn't override the default context explicitly.
    ssl._create_default_https_context = ssl._create_unverified_context
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
    # Also patch huggingface_hub's own session factory so its retry logic
    # doesn't re-enable verification on a fresh session.
    try:
        import requests
        from huggingface_hub import configure_http_backend

        def _no_verify_backend() -> requests.Session:
            session = requests.Session()
            session.verify = False
            return session

        configure_http_backend(backend_factory=_no_verify_backend)
    except Exception:
        pass

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
        already = {
            row[0]
            for row in db.execute(
                text("SELECT rowid FROM chunks_vec WHERE rowid IN (:ids)").bindparams(
                    sqlalchemy.bindparam("ids", expanding=True)
                ),
                {"ids": all_ids},
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
    from app.embeddings.model import get_model
    actual = int(len(list(get_model().embed(["x"]))[0]))
    if EMBEDDING_DIM_OVERRIDE is not None:
        if actual != EMBEDDING_DIM_OVERRIDE:
            logging.warning(
                f"EMBEDDING_DIM={EMBEDDING_DIM_OVERRIDE} does not match the model's actual output "
                f"dimension ({actual}d). Embedding inserts will fail with a dimension mismatch. "
                f"Remove EMBEDDING_DIM or set it to {actual}."
            )
        logging.info(f"Embedding dimension: {EMBEDDING_DIM_OVERRIDE} (from EMBEDDING_DIM env var)")
        return EMBEDDING_DIM_OVERRIDE
    logging.info(f"Embedding dimension: {actual} (auto-detected from {EMBEDDING_MODEL})")
    return actual


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

_cors_origins = [o.strip() for o in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173,http://127.0.0.1:3000",
).split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
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
            embedded = db.execute(
                text("SELECT COUNT(*) FROM chunks_vec WHERE rowid IN (:ids)").bindparams(
                    sqlalchemy.bindparam("ids", expanding=True)
                ),
                {"ids": all_ids},
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
        "reindexing": chunk_count > 0 and unembedded == chunk_count,
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

    _frontend_real = os.path.realpath(_FRONTEND_DIR)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def _serve_frontend(full_path: str):
        if full_path:
            candidate = os.path.realpath(os.path.join(_FRONTEND_DIR, full_path))
            if candidate.startswith(_frontend_real + os.sep) and os.path.isfile(candidate):
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
