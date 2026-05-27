from __future__ import annotations
import logging
import numpy as np
from fastembed import TextEmbedding
from app.config import EMBEDDING_MODEL

_model: TextEmbedding | None = None


def get_model() -> TextEmbedding | None:
    return _model


def load_model() -> TextEmbedding:
    global _model
    if _model is None:
        logging.info(f"Lade Embedding-Modell: {EMBEDDING_MODEL} …")
        try:
            from tqdm.contrib.logging import logging_redirect_tqdm
            with logging_redirect_tqdm():
                _model = TextEmbedding(EMBEDDING_MODEL)
        except ValueError:
            supported = sorted(m["model"] for m in TextEmbedding.list_supported_models())
            raise ValueError(
                f"EMBEDDING_MODEL='{EMBEDDING_MODEL}' wird von fastembed nicht unterstützt.\n"
                f"Unterstützte Modelle:\n" + "\n".join(f"  {m}" for m in supported)
            )
        logging.info(f"Embedding-Modell geladen: {EMBEDDING_MODEL}")
    return _model


def encode(text: str) -> np.ndarray:
    return list(load_model().embed([text]))[0].astype(np.float32)


encode_query = encode
encode_passage = encode


def to_bytes(emb: np.ndarray) -> bytes:
    return emb.astype(np.float32).tobytes()
