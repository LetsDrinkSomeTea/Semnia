import asyncio
import logging
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session

from app.db.init_db import init_db, insert_seed_data
from app.db.session import get_db
from app.embeddings.model import load_model
from app.embeddings.queue import embedding_worker
from app.routers import entries, search, tags, import_, settings

logging.basicConfig(level=logging.INFO)

os.makedirs(os.getenv("UPLOAD_PATH", "./data/uploads"), exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    insert_seed_data()
    load_model()
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
def api_status(db: Session = Depends(get_db)):
    from app.db.models import Entry
    from app.embeddings.model import get_model
    entry_count = db.query(Entry).count()
    return {
        "entry_count": entry_count,
        "model": "intfloat/multilingual-e5-small",
        "model_ready": get_model() is not None,
    }
