from __future__ import annotations
import numpy as np
from sentence_transformers import SentenceTransformer
from app.config import EMBEDDING_MODEL

_model: SentenceTransformer | None = None


def get_model() -> SentenceTransformer | None:
    return _model


def load_model() -> SentenceTransformer:
    global _model
    if _model is None:
        _model = SentenceTransformer(EMBEDDING_MODEL)
    return _model


def encode_query(text: str) -> np.ndarray:
    model = load_model()
    emb = model.encode(f"query: {text}", normalize_embeddings=True)
    return emb.astype(np.float32)


def encode_passage(text: str) -> np.ndarray:
    model = load_model()
    emb = model.encode(f"passage: {text}", normalize_embeddings=True)
    return emb.astype(np.float32)


def to_bytes(emb: np.ndarray) -> bytes:
    return emb.astype(np.float32).tobytes()
