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

from app.config import EMBEDDING_MODEL, EMBEDDING_DIM_OVERRIDE, TZ, SSL_VERIFY, UPLOAD_PATH, DEMO
from app.db.init_db import init_db, insert_seed_data
from app.db.session import get_db
from app.embeddings.model import load_model
from app.embeddings.queue import embedding_worker
from app.routers import entries, search, tags, import_, settings, agent

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

# ── Agent SDK Tracing ────────────────────────────────────────────────────────
# The OpenAI Agents SDK sends traces to the OpenAI platform via OPENAI_API_KEY.
# 1. Explicit key via LLM_TRACES_OPENAI_KEY takes priority.
# 2. Auto-detect: if LLM_URL points to OpenAI and LLM_API_KEY is set, reuse it.
# 3. Otherwise: disable tracing (no valid key → would fail silently).
_traces_key = os.getenv("LLM_TRACES_OPENAI_KEY", "")
if not _traces_key:
    _llm_url = os.getenv("LLM_URL", "")
    _llm_key = os.getenv("LLM_API_KEY", "")
    if "openai.com" in _llm_url and _llm_key:
        _traces_key = _llm_key

if _traces_key:
    os.environ["OPENAI_API_KEY"] = _traces_key
    logging.info("Agent tracing enabled (traces → OpenAI dashboard)")
else:
    os.environ["OPENAI_AGENTS_DISABLE_TRACING"] = "1"
    logging.info("Agent tracing disabled (no OpenAI key for traces)")

os.makedirs(UPLOAD_PATH, exist_ok=True)


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
        from app.search.meilisearch_client import client, INDEX_NAME
        try:
            stats = client.index(INDEX_NAME).get_stats()
            if stats.number_of_documents >= len(all_ids):
                return
        except Exception:
            pass
        missing = all_ids
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
    from app.search.meilisearch_client import init_meilisearch
    init_meilisearch(dim)
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
app.include_router(agent.router)


async def _fetch_status_data(db: Session, cached_llm_status: str | None = None) -> dict:
    import httpx
    from sqlalchemy import text
    from app.db.models import Entry, Chunk, Setting
    from app.embeddings.model import get_model
    from app.embeddings.queue import get_queue_size

    entry_count = db.query(Entry).count()
    chunk_count = db.query(Chunk).count()

    meilisearch_stats = None
    try:
        from app.search.meilisearch_client import client, INDEX_NAME
        stats = client.index(INDEX_NAME).get_stats()
        meilisearch_stats = {
            "number_of_documents": stats.number_of_documents,
            "is_indexing": stats.is_indexing
        }
    except Exception:
        pass

    unembedded = get_queue_size()

    db_size_bytes = 0
    try:
        db_size_bytes = os.path.getsize(os.getenv("DB_PATH", "./data/wissensdatenbank.sqlite"))
    except OSError:
        pass

    llm_url_setting = db.query(Setting).filter(Setting.key == "llm_url").first()
    llm_url = json.loads(llm_url_setting.value) if llm_url_setting else "http://ollama:11434/v1"

    llm_api_key_setting = db.query(Setting).filter(Setting.key == "llm_api_key").first()
    llm_api_key = json.loads(llm_api_key_setting.value) if llm_api_key_setting else ""

    llm_model_setting = db.query(Setting).filter(Setting.key == "llm_model").first()
    llm_model = json.loads(llm_model_setting.value) if llm_model_setting else ""

    llm_status = cached_llm_status or "inactive"
    if cached_llm_status is None:
        try:
            headers = {"Authorization": f"Bearer {llm_api_key}"} if llm_api_key else {}
            async with httpx.AsyncClient(timeout=2.0, verify=SSL_VERIFY) as client_http:
                r = await client_http.get(f"{llm_url}/models", headers=headers)
                llm_status = "ready" if r.status_code == 200 else "error"
        except (httpx.ConnectError, httpx.TimeoutException):
            llm_status = "inactive"
        except Exception:
            llm_status = "error"

    agent_max_turns_setting = db.query(Setting).filter(Setting.key == "agent_max_turns").first()
    agent_max_turns = json.loads(agent_max_turns_setting.value) if agent_max_turns_setting else 10

    return {
        "entry_count": entry_count,
        "chunk_count": chunk_count,
        "unembedded_chunks": unembedded,
        "reindexing": chunk_count > 0 and unembedded == chunk_count,
        "db_size_bytes": db_size_bytes,
        "model": EMBEDDING_MODEL,
        "model_ready": get_model() is not None,
        "llm_status": llm_status,
        "llm_model": llm_model,
        "agent_max_turns": agent_max_turns,
        "meilisearch_stats": meilisearch_stats,
        "tz": TZ,
        "ssl_verify": SSL_VERIFY,
        "demo": DEMO,
        "upload_path": UPLOAD_PATH,
        "db_path_str": os.getenv("DB_PATH", "/data/wissensdatenbank.sqlite"),
        "meilisearch_url": os.getenv("MEILISEARCH_URL", "http://localhost:7700"),
        "cors_origins": os.getenv("CORS_ORIGINS", ""),
    }


@app.get("/api/status")
async def api_status(db: Session = Depends(get_db)):
    return await _fetch_status_data(db)


@app.get("/api/status/stream")
async def api_status_stream():
    from fastapi.responses import StreamingResponse
    from app.db.session import SessionLocal

    async def event_generator():
        counter = 0
        cached_llm_status = None
        while True:
            db = SessionLocal()
            try:
                if counter % 10 == 0:
                    cached_llm_status = None  # Force re-check
                
                data = await _fetch_status_data(db, cached_llm_status=cached_llm_status)
                cached_llm_status = data["llm_status"]
                
                yield f"data: {json.dumps(data)}\n\n"
            except asyncio.CancelledError:
                break
            except Exception as e:
                logging.error(f"SSE status error: {e}")
            finally:
                db.close()
                
            counter += 1
            await asyncio.sleep(2)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


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
