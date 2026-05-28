import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.embeddings.model import encode_query, to_bytes

_CHUNK_BOOST: dict[str, float] = {
    "title": 1.3,
    "question": 1.15,
    "answer": 1.0,
    "content": 1.0,
}


def semantic_search(
    db: Session,
    query: str,
    top_k: int = 30,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
) -> list[tuple[int, float, int]]:
    """Returns (entry_id, boosted_cosine_similarity, best_chunk_id) sorted by similarity desc."""
    emb = encode_query(query)
    emb_bytes = to_bytes(emb)

    rows = db.execute(
        text("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH :emb ORDER BY distance LIMIT :k"),
        {"emb": emb_bytes, "k": top_k * 5},
    ).fetchall()

    if not rows:
        return []

    from app.db.models import Chunk
    chunk_ids = [int(r[0]) for r in rows]
    chunks_data = db.query(Chunk.id, Chunk.entry_id, Chunk.chunk_type).filter(Chunk.id.in_(chunk_ids)).all()
    chunk_to_entry = {c.id: c.entry_id for c in chunks_data}
    chunk_type_lookup = {c.id: c.chunk_type for c in chunks_data}

    # Deduplicate by entry_id, keep best boosted score and its chunk_id
    best: dict[int, float] = {}
    best_chunk: dict[int, int] = {}
    for rowid, distance in rows:
        chunk_id = int(rowid)
        entry_id = chunk_to_entry.get(chunk_id)
        if entry_id is None:
            continue
        cosine_sim = float(np.clip(1.0 - (distance ** 2) / 2.0, 0.0, 1.0))
        chunk_type = chunk_type_lookup.get(chunk_id, "content")
        boosted = min(cosine_sim * _CHUNK_BOOST.get(chunk_type, 1.0), 1.0)
        if entry_id not in best or boosted > best[entry_id]:
            best[entry_id] = boosted
        if entry_id not in best_chunk:
            best_chunk[entry_id] = chunk_id

    results = sorted(
        [(eid, score, best_chunk[eid]) for eid, score in best.items()],
        key=lambda x: x[1],
        reverse=True,
    )

    if entry_type or tag_filter:
        results = _apply_filters(db, results, entry_type, tag_filter)

    return results[:top_k]


def _apply_filters(
    db: Session,
    results: list[tuple[int, float, int]],
    entry_type: str | None,
    tag_filter: list[str] | None,
) -> list[tuple[int, float, int]]:
    from app.db.models import Entry, EntryTag

    q = db.query(Entry.id)
    if entry_type:
        q = q.filter(Entry.entry_type == entry_type)
    if tag_filter:
        for tag in tag_filter:
            q = q.join(EntryTag, Entry.id == EntryTag.entry_id).filter(EntryTag.tag == tag)

    valid_ids = {row[0] for row in q.all()}
    return [(rid, sim, cid) for rid, sim, cid in results if rid in valid_ids]
