import os
import json
import logging
import meilisearch
from app.config import MEILISEARCH_URL, MEILISEARCH_KEY, SSL_VERIFY
from app.db.models import Entry, Chunk

logger = logging.getLogger(__name__)

# Initialize client
client = meilisearch.Client(MEILISEARCH_URL, MEILISEARCH_KEY)
INDEX_NAME = "semnia_chunks"

def init_meilisearch(embedding_dim: int):
    try:
        import httpx
        # Enable vector store feature manually via HTTP to avoid client version issues
        headers = {"Authorization": f"Bearer {MEILISEARCH_KEY}"} if MEILISEARCH_KEY else {}
        httpx.patch(
            f"{MEILISEARCH_URL.rstrip('/')}/experimental-features",
            json={"vectorStore": True},
            headers=headers,
            verify=SSL_VERIFY,
        )
        
        index = client.index(INDEX_NAME)
        # Create index if not exists (Meilisearch creates it automatically on first document addition,
        # but we want to configure settings immediately)
        try:
            client.create_index(INDEX_NAME, {'primaryKey': 'id'})
        except Exception:
            pass # Index might already exist
            
        index.update_filterable_attributes(['entry_id', 'entry_type', 'tags'])
        index.update_searchable_attributes(['title', 'question', 'answer', 'content', 'tags'])
        index.update_distinct_attribute('entry_id')
        
        # Configure embedding settings
        index.update_embedders({
            'default': {
                'source': 'userProvided',
                'dimensions': embedding_dim
            }
        })
        logger.info(f"Meilisearch index '{INDEX_NAME}' initialized with dim {embedding_dim}")
    except Exception as e:
        logger.error(f"Failed to initialize Meilisearch: {e}")


def upsert_chunk(entry: Entry, chunk: Chunk, embedding: list[float]):
    """Syncs a single chunk to Meilisearch."""
    tags_list = json.loads(entry.tags or "[]")
    
    doc = {
        "id": f"chunk_{chunk.id}",
        "entry_id": entry.id,
        "chunk_id": chunk.id,
        "chunk_type": chunk.chunk_type,
        "entry_type": entry.entry_type,
        "title": entry.title or "",
        "question": entry.question or "",
        "answer": entry.answer or "",
        "content": chunk.content or "",
        "tags": tags_list,
        "call_count": entry.call_count,
        "_vectors": {
            "default": embedding
        }
    }
    
    try:
        client.index(INDEX_NAME).add_documents([doc])
    except Exception as e:
        logger.error(f"Meilisearch upsert failed for chunk {chunk.id}: {e}")


def delete_chunks_from_meili(chunk_ids: list[int]):
    if not chunk_ids:
        return
    try:
        doc_ids = [f"chunk_{cid}" for cid in chunk_ids]
        client.index(INDEX_NAME).delete_documents(doc_ids)
    except Exception as e:
        logger.error(f"Meilisearch delete failed for chunks {chunk_ids}: {e}")


def search(
    query: str, 
    threshold: float = 0.3, 
    top_k: int = 15, 
    page: int = 1,
    entry_type: str | None = None, 
    tag_filter: list[str] | None = None,
    hybrid: bool = True
) -> list[dict]:
    
    index = client.index(INDEX_NAME)
    
    filters = []
    if entry_type:
        filters.append(f"entry_type = {entry_type}")
    if tag_filter:
        for tag in tag_filter:
            filters.append(f"tags = '{tag}'")
            
    filter_str = " AND ".join(filters) if filters else None
    
    search_params = {
        "limit": top_k,
        "offset": (page - 1) * top_k,
        "showRankingScore": True
    }
    
    if filter_str:
        search_params["filter"] = filter_str
        
    if hybrid:
        from app.embeddings.model import encode_query
        emb = encode_query(query).tolist()
        search_params["vector"] = emb
        search_params["hybrid"] = {"semanticRatio": 0.6} # 60% semantic, 40% keyword
        
    try:
        res = index.search(query, search_params)
        hits = res.get('hits', [])
    except Exception as e:
        logger.error(f"Meilisearch search failed: {e}")
        return []

    # Deduplicate by entry_id
    best_hits = {}
    for hit in hits:
        eid = hit['entry_id']
        # If showRankingScore is True, Meilisearch returns '_rankingScore'
        score = hit.get('_rankingScore', hit.get('_semanticScore', 0.5))
        
        if eid not in best_hits or score > best_hits[eid]['score']:
            best_hits[eid] = {
                "id": eid,
                "entry_type": hit['entry_type'],
                "title": hit['title'],
                "display_title": hit['title'] or hit.get('question') or "Ohne Titel",
                "question": hit['question'],
                "answer": hit.get('answer', ''),
                # For UI display, we'll mimic the old snippet behavior using hit formatting
                "snippet": hit.get('_formatted', {}).get('content', hit['content'][:200] + "...") if hit.get('_formatted') else hit['content'][:200] + "...",
                "highlight_spans": [], # Meilisearch can do highlighting, but we omit precise spans for now to simplify
                "score": round(score, 4),
                "tags": hit['tags'],
                "call_count": hit['call_count'],
                "matched_by": "meilisearch",
                "matched_chunk_type": hit['chunk_type'],
                "matched_chunk_id": hit['chunk_id']
            }
            
    results = sorted(best_hits.values(), key=lambda x: x['score'], reverse=True)
    
    # Filter by threshold if doing vector search
    if hybrid:
        results = [r for r in results if r['score'] >= threshold]
        
    return results[:top_k]
