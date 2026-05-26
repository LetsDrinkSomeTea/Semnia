import os

DB_PATH = os.getenv("DB_PATH", "./data/wissensdatenbank.sqlite")
UPLOAD_PATH = os.getenv("UPLOAD_PATH", "./data/uploads")
EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
EMBEDDING_DIM = 384

DEFAULT_SETTINGS: dict = {
    "search_threshold": 0.4,
    "dupe_threshold": 0.92,
    "top_k": 10,
    "hybrid_alpha": 0.7,
    "branding_accent": "#4F46E5",
    "branding_font": "Inter, system-ui, sans-serif",
    "branding_logo_b64": "",
    "ollama_url": "http://ollama:11434",
    "ollama_model": "llama3.2:3b",
}
