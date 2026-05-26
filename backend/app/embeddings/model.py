from __future__ import annotations
import numpy as np
from fastembed import TextEmbedding
from app.config import EMBEDDING_MODEL

_model: TextEmbedding | None = None


def get_model() -> TextEmbedding | None:
    return _model


def load_model() -> TextEmbedding:
    global _model
    if _model is None:
        _model = TextEmbedding(EMBEDDING_MODEL)
    return _model


def encode_query(text: str) -> np.ndarray:
    result = list(load_model().embed([text]))
    return result[0].astype(np.float32)


def encode_passage(text: str) -> np.ndarray:
    result = list(load_model().embed([text]))
    return result[0].astype(np.float32)


def to_bytes(emb: np.ndarray) -> bytes:
    return emb.astype(np.float32).tobytes()
