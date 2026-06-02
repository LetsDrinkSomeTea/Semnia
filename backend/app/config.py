import os
import base64

TZ = os.getenv("TZ", "Europe/Berlin")
SSL_VERIFY: bool = os.getenv("SSL_VERIFY", "true").lower() not in ("0", "false", "no")
DB_PATH = os.getenv("DB_PATH", "/data/wissensdatenbank.sqlite")
UPLOAD_PATH = os.getenv("UPLOAD_PATH", "/data/uploads")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "sentence-transformers/paraphrase-multilingual-mpnet-base-v2")
DEMO: bool = os.getenv("DEMO", "").lower() in ("1", "true", "yes")
# Explicit override only — normally left unset and auto-detected from the loaded model at startup.
EMBEDDING_DIM_OVERRIDE: int | None = int(os.getenv("EMBEDDING_DIM")) if os.getenv("EMBEDDING_DIM") else None

MEILISEARCH_URL = os.getenv("MEILISEARCH_URL", "http://localhost:7700")
MEILISEARCH_KEY = os.getenv("MEILISEARCH_KEY", "")

DEFAULT_SETTINGS: dict = {
    "search_threshold": 0.3,
    "dupe_threshold": 0.9,
    "top_k": 15,
    "hybrid_alpha": 0.7,
    "chunk_size": 200,
    "chunk_overlap": 40,
    "branding_name": "Semnia",
    "branding_accent": "#9933ee",
    "branding_font": "Inter, system-ui, sans-serif",
    "branding_logo_b64": "",
    "branding_custom_css": "",
    "llm_url": "http://ollama:11434/v1",
    "llm_model": "llama3.2:1b",
    "llm_api_key": "",
}


def _build_settings_overrides() -> dict:
    """Read env vars and return a dict of settings keys to override in the DB on startup."""
    overrides: dict = {}

    _float = lambda k, s: overrides.update({s: float(v)}) if (v := os.getenv(k)) else None
    _int   = lambda k, s: overrides.update({s: int(v)})   if (v := os.getenv(k)) else None
    _str   = lambda k, s: overrides.update({s: v})        if (v := os.getenv(k)) else None

    _float("SEARCH_THRESHOLD", "search_threshold")
    _float("DUPE_THRESHOLD",   "dupe_threshold")
    _int  ("TOP_K",            "top_k")
    _float("HYBRID_ALPHA",     "hybrid_alpha")
    _int  ("CHUNK_SIZE",       "chunk_size")
    _int  ("CHUNK_OVERLAP",    "chunk_overlap")
    _str  ("APP_NAME",         "branding_name")
    _str  ("ACCENT_COLOR",     "branding_accent")
    _str  ("FONT_STACK",       "branding_font")
    _str  ("LLM_URL",           "llm_url")
    _str  ("LLM_MODEL",        "llm_model")
    _str  ("LLM_API_KEY",      "llm_api_key")

    # Custom CSS — inline string or file path
    if css := os.getenv("CUSTOM_CSS"):
        overrides["branding_custom_css"] = css
    elif css_file := os.getenv("CUSTOM_CSS_FILE"):
        try:
            with open(css_file) as f:
                overrides["branding_custom_css"] = f.read()
        except OSError:
            pass

    # Logo — file path, base64-encoded and stored
    if logo_file := os.getenv("BRANDING_LOGO_FILE"):
        try:
            with open(logo_file, "rb") as f:
                ext = os.path.splitext(logo_file)[1].lstrip(".") or "png"
                mime = "image/svg+xml" if ext == "svg" else f"image/{ext}"
                overrides["branding_logo_b64"] = f"data:{mime};base64," + base64.b64encode(f.read()).decode()
        except OSError:
            pass

    return overrides


SETTINGS_OVERRIDES: dict = _build_settings_overrides()
