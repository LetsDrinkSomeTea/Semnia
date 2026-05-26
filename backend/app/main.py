import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.config import EMBEDDING_MODEL
from app.db.init_db import init_db, insert_seed_data
from app.db.session import get_db
from app.embeddings.model import load_model
from app.embeddings.queue import embedding_worker
from app.routers import entries, search, tags, import_, settings

logging.basicConfig(level=logging.INFO)

os.makedirs(os.getenv("UPLOAD_PATH", "./data/uploads"), exist_ok=True)


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    insert_seed_data()
    load_model()
    _enqueue_missing_embeddings()
    task = asyncio.create_task(embedding_worker())
    yield
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


app = FastAPI(title="Wissensdatenbank", lifespan=lifespan)

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
    from app.db.models import Entry, Setting
    from app.embeddings.model import get_model

    entry_count = db.query(Entry).count()

    ollama_setting = db.query(Setting).filter(Setting.key == "ollama_url").first()
    ollama_url = json.loads(ollama_setting.value) if ollama_setting else "http://ollama:11434"

    ollama_ready = False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            r = await client.get(f"{ollama_url}/api/tags")
            ollama_ready = r.status_code == 200
    except Exception:
        pass

    return {
        "entry_count": entry_count,
        "model": EMBEDDING_MODEL,
        "model_ready": get_model() is not None,
        "ollama_ready": ollama_ready,
    }
