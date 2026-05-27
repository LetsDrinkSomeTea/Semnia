# Semnia

Self-hosted internal knowledge base with hybrid semantic and full-text search. Designed for teams that want a fast, private alternative to scattered Confluence pages, Notion docs, and Slack threads — running entirely on your own infrastructure, with no data leaving your network.

## What it does

- **Two knowledge types** — Q&A entries (question + answer, manually created) and Document entries (Markdown, PDF, DOCX files, automatically chunked)
- **Hybrid search** — semantic vector search and BM25 full-text search combined, with umlaut normalization and fuzzy fallback for typos
- **AI summaries** — optional Ollama integration generates 2–4 sentence answers with source citations directly in the search results
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

The app starts with a small set of example entries. Create your first real entry via **Neu** in the navigation, or upload a document via **Import**.

### With AI summaries (Ollama)

```bash
docker compose --profile llm up -d
```

This starts an additional Ollama container. On first run it downloads `llama3.2:3b` (~2 GB). Once ready, a **KI-Zusammenfassung** button appears in search results.


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
| `SEARCH_THRESHOLD` | `0.3` | Minimum score to show a result. Lower = more results. |
| `DUPE_THRESHOLD` | `0.9` | Similarity above which a new entry is flagged as a duplicate. |
| `TOP_K` | `15` | Maximum results per search. |
| `HYBRID_ALPHA` | `0.7` | Semantic vs. full-text weight. `1.0` = pure semantic, `0.0` = pure BM25. |
| `EMBEDDING_MODEL` | `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` | Embedding model for semantic search. Changing it triggers a full reindex on next startup. |
| `OLLAMA_URL` | _(empty)_ | Ollama API endpoint. Set to enable AI summaries, e.g. `http://ollama:11434`. |
| `OLLAMA_MODEL` | `llama3.2:3b` | Model used for AI summaries. Must be available on the Ollama server. |
| `CUSTOM_CSS_FILE` | — | Path to a mounted CSS file injected into the frontend. |
| `BRANDING_LOGO_FILE` | — | Path to a mounted PNG/SVG logo file. |

See [`.env.example`](./.env.example) for the full list with descriptions.

### Mounting custom assets

The production compose mounts `./custom` into the app container at `/custom`. Place logo and CSS files there:

```
custom/
  logo.svg
  custom.css
```

```yaml
# docker-compose.override.yml
services:
  backend:
    environment:
      - BRANDING_LOGO_FILE=/custom/logo.svg
      - CUSTOM_CSS_FILE=/custom/custom.css
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

To reset to the built-in example data:

```bash
# Via the UI: Settings → Auf Seed-Daten zurücksetzen
# Or via the API:
curl -X POST http://localhost:3000/api/settings/reset
```


## Development

The dev setup mounts source files directly into the running container for hot reload — no rebuild needed on code changes.

```bash
docker compose -f docker-compose.dev.yaml up
```

- Frontend: `http://localhost:5173` (Vite HMR)
- Backend: auto-reloads via uvicorn `--reload`
- Ollama: starts alongside with `llama3.2:3b` (pulled automatically on first run)
