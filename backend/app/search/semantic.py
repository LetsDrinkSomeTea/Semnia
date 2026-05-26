import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session
from app.embeddings.model import encode_query, to_bytes


def semantic_search(
    db: Session,
    query: str,
    top_k: int = 30,
    entry_type: str | None = None,
    tag_filter: list[str] | None = None,
) -> list[tuple[int, float]]:
    """Returns (entry_id, cosine_similarity) pairs sorted by similarity desc."""
    emb = encode_query(query)
    emb_bytes = to_bytes(emb)

    rows = db.execute(
        text("SELECT rowid, distance FROM chunks_vec WHERE embedding MATCH :emb ORDER BY distance LIMIT :k"),
        {"emb": emb_bytes, "k": top_k * 5},
    ).fetchall()

    if not rows:
        return []

    # Map chunk IDs to entry IDs
    from app.db.models import Chunk
    chunk_ids = [int(r[0]) for r in rows]
    chunk_to_entry = {
        c.id: c.entry_id
        for c in db.query(Chunk).filter(Chunk.id.in_(chunk_ids)).all()
    }

    # Deduplicate by entry_id, keep best cosine score
    best: dict[int, float] = {}
    for rowid, distance in rows:
        entry_id = chunk_to_entry.get(int(rowid))
        if entry_id is None:
            continue
        cosine_sim = float(np.clip(1.0 - (distance ** 2) / 2.0, 0.0, 1.0))
        if entry_id not in best or cosine_sim > best[entry_id]:
            best[entry_id] = cosine_sim

    results = sorted(best.items(), key=lambda x: x[1], reverse=True)

    if entry_type or tag_filter:
        results = _apply_filters(db, results, entry_type, tag_filter)

    return results[:top_k]


def _apply_filters(
    db: Session,
    results: list[tuple[int, float]],
    entry_type: str | None,
    tag_filter: list[str] | None,
) -> list[tuple[int, float]]:
    from app.db.models import Entry, EntryTag

    q = db.query(Entry.id)
    if entry_type:
        q = q.filter(Entry.entry_type == entry_type)
    if tag_filter:
        for tag in tag_filter:
            q = q.join(EntryTag, Entry.id == EntryTag.entry_id).filter(EntryTag.tag == tag)

    valid_ids = {row[0] for row in q.all()}
    return [(rid, sim) for rid, sim in results if rid in valid_ids]
