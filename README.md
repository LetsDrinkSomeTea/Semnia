# Semnia

Self-hosted internal knowledge base with semantic search. Designed for teams that want a fast, private alternative to scattered Confluence pages, Notion docs, and Slack threads — running entirely on your own infrastructure, with no data leaving your network.

## What it does

- **Two knowledge types** — Q&A entries (question + answer, manually created) and Document entries (Markdown, PDF, DOCX files, automatically chunked)
- **Semantic search** — vector search with relative relevance scoring; scores are normalized so 0% = noise floor and 100% = perfect match
- **Fuzzy search** — typo-tolerant word matching with query correction suggestions, available as a separate search endpoint
- **AI summaries** — optional integration with any OpenAI-compatible API (OpenAI, Ollama, LM Studio, vLLM) generates 2–4 sentence answers with source citations directly in the search results
- **Duplicate detection** — live similarity check while writing new entries
- **Tag system** — filter by topic in search and browse, with content-based tag suggestions
- **Branding** — configurable app name, accent color, font, logo, and custom CSS via env vars


## Quickstart

**Requirements:** Docker and Docker Compose.

```bash
# 1. Clone the repository
git clone https://github.com/letsdrinksometea/semnia
cd semnia

# 2. Start (pulls images, no build required)
docker compose up -d

# 3. Open in browser
open http://localhost:3000
```

The app starts with a small set of example entries. Create your first real entry via **Erstellen** in the navigation, or upload a document there.

> **First startup:** The embedding model (~280 MB) is downloaded automatically on the first run and cached in the `semnia-model-cache` Docker volume. This can take a few minutes depending on your internet connection — progress is visible in the container logs. Subsequent starts are instant.
>
> **Network access required:** The standard image needs to reach `huggingface.co` on first startup. If your environment blocks this (corporate proxy, firewall, air-gapped network), use the `-offline` image instead.

### Offline / air-gapped environments

If the container cannot reach HuggingFace at runtime, use the `-offline` image variant. It has the default embedding model pre-baked and starts instantly without any download or network access:

```yaml
# docker-compose.override.yml
services:
  app:
    image: ghcr.io/letsdrinksometea/semnia:main-offline
    # model-cache volume not needed
```

The offline image is built from the same source and released alongside the standard image. It is larger (~280 MB extra) but otherwise identical.

### With AI summaries

The AI summary feature works with any OpenAI-compatible API. Set at minimum `LLM_URL` and `LLM_MODEL`. Set `LLM_API_KEY` when using an API that requires authentication (e.g. OpenAI). Once configured and reachable, a **✦ KI-Zusammenfassung** button appears in search results.

**Ollama (bundled, recommended):** The app defaults to `http://ollama:11434/v1` with model `llama3.2:1b`. Just start with the `llm` profile — no extra env vars needed:

```bash
docker compose --profile llm up -d
```

On first run, Ollama downloads `llama3.2:1b` (~1.3 GB). Once it's up, the **✦ KI-Zusammenfassung** button appears automatically.

**Other models or OpenAI:**

```yaml
# docker-compose.override.yml — different Ollama model
services:
  app:
    environment:
      - LLM_MODEL=llama3.2:3b

# docker-compose.override.yml — OpenAI
services:
  app:
    environment:
      - LLM_URL=https://api.openai.com/v1
      - LLM_MODEL=gpt-4o-mini
      - LLM_API_KEY=sk-...
```


## Configuration

All settings are configured via environment variables. Copy `.env.example` to `.env` and adjust as needed — every variable is optional and has a sensible default.

```bash
cp .env.example .env
```

Pass variables to Docker Compose via the `.env` file at the project root, or directly in your `docker-compose.override.yml`:

```yaml
services:
  app:
    environment:
      - APP_NAME=Acme Wiki
      - ACCENT_COLOR=#0ea5e9
      - SEARCH_THRESHOLD=0.25
```

### Key settings

| Variable | Default | Description |
|---|---|---|
| `APP_NAME` | `Semnia` | Display name in topbar and browser tab. Last 3 chars are accented. |
| `ACCENT_COLOR` | `#9933ee` | Primary color for buttons, links, and highlights. |
| `FONT_STACK` | `Inter, system-ui, sans-serif` | CSS font-family stack applied to body and headings. |
| `SEARCH_THRESHOLD` | `0.3` | Minimum relevance score to show a result (relative scale: 0% = noise, 100% = perfect match). |
| `DUPE_THRESHOLD` | `0.9` | Similarity above which a new entry is flagged as a duplicate. |
| `TOP_K` | `15` | Maximum results per search. |
| `HYBRID_ALPHA` | `0.7` | Reserved; currently unused. |
| `CHUNK_SIZE` | `200` | Max characters per chunk. Smaller = more precise retrieval. Changing triggers re-embedding. |
| `CHUNK_OVERLAP` | `40` | Overlap between consecutive chunks in characters. |
| `EMBEDDING_MODEL` | `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` | Embedding model for semantic search. Changing it triggers a full reindex on next startup. |
| `SSL_VERIFY` | `true` | Set to `false` to disable HTTPS certificate verification for HuggingFace downloads. Use when your network has a corporate CA that Python does not trust. Not needed with the `-offline` image. |
| `LLM_URL` | `http://ollama:11434/v1` | Base URL of any OpenAI-compatible API. Default points to the bundled Ollama container. |
| `LLM_MODEL` | `llama3.2:1b` | Model name passed to the LLM API. |
| `LLM_API_KEY` | _(empty)_ | API key for the LLM endpoint. Not required for local services (Ollama, LM Studio). |
| `CUSTOM_CSS` | _(empty)_ | Inline CSS string injected into the frontend as a `<style>` tag. |
| `CUSTOM_CSS_FILE` | _(empty)_ | Path to a mounted CSS file injected into the frontend. Takes precedence over `CUSTOM_CSS`. |
| `BRANDING_LOGO_FILE` | _(empty)_ | Path to a mounted PNG/SVG logo file. |
| `TZ` | `Europe/Berlin` | IANA timezone name (affects log timestamps). |
| `CORS_ORIGINS` | `http://localhost:5173,http://localhost:3000,...` | Comma-separated list of allowed CORS origins. |

See [`.env.example`](./.env.example) for the full list with descriptions.

### Mounting custom assets

The production compose does **not** mount a custom directory by default. Add a volume in your `docker-compose.override.yml`:

```yaml
# docker-compose.override.yml
services:
  app:
    volumes:
      - ./custom:/custom:ro
    environment:
      - BRANDING_LOGO_FILE=/custom/logo.svg
      - CUSTOM_CSS_FILE=/custom/custom.css
```

Then place your files in `./custom/`:

```
custom/
  logo.svg
  custom.css
```

### Changing the embedding model

The embedding dimension is auto-detected from the model at startup. Simply set `EMBEDDING_MODEL` — if the dimension differs from the stored one, the vector index is rebuilt automatically and all entries are re-embedded:

```bash
EMBEDDING_MODEL=intfloat/multilingual-e5-large
```

Recommended multilingual models by size:

| Model | Dim | Size | Notes |
|---|---|---|---|
| `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` | 384 | ~120 MB | Fast, compact, ~50 languages. Good when resources are tight. |
| `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` | 768 | ~280 MB | **Default.** Good balance of quality and speed. ~50 languages. |
| `intfloat/multilingual-e5-large` | 1024 | ~560 MB | Best quality, ~100 languages, needs ~1 GB RAM. |
| `jinaai/jina-embeddings-v2-base-de` | 768 | ~280 MB | German + English optimised, up to 8192 tokens. |


## Data

All data is stored in a single SQLite file at `DB_PATH` (default `/data/wissensdatenbank.sqlite`). The Docker volume persists across restarts. To back up, copy that file.


## Development

The dev setup mounts source files directly into the running container for hot reload — no rebuild needed on code changes.

```bash
docker compose -f docker-compose.dev.yaml up
```

- Frontend: `http://localhost:5173` (Vite HMR)
- Backend: `http://localhost:8000` (uvicorn `--reload`)
- Ollama (optional, `--profile llm`): starts with `llama3.2:1b` pulled automatically on first run
