# ── Stage 1: build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS frontend

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --frozen-lockfile 2>/dev/null || npm install
COPY frontend/ .
RUN npm run build

# ── Stage 2: Python backend deps/base (reused by app + model download) ───────
FROM python:3.12-slim AS backend-base

WORKDIR /backend

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -r appuser && useradd -r -g appuser -d /backend appuser \
    && mkdir -p /data /model-cache /model-baked \
    && chown -R appuser:appuser /backend /data /model-cache /model-baked

COPY --chown=appuser:appuser backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV PYTHONDONTWRITEBYTECODE=1

USER appuser

# ── Stage 3: Python backend (usable standalone via --target backend) ─────────
FROM backend-base AS backend

ENV FASTEMBED_CACHE_PATH=/model-cache

COPY --chown=appuser:appuser backend/app/ app/

# ── Stage 4: combined image ──────────────────────────────────────────────────
FROM backend AS app

ENV FRONTEND_DIR=/app/frontend

COPY --from=frontend --chown=appuser:appuser /app/dist /app/frontend

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=120s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/status')"

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ── Stage 5: model download (depends only on backend deps, not app code) ─────
# Separate stage so the model layer is not invalidated by app code changes.
FROM backend-base AS model-download

ENV FASTEMBED_CACHE_PATH=/model-baked
RUN python -c "from fastembed import TextEmbedding; list(TextEmbedding('sentence-transformers/paraphrase-multilingual-mpnet-base-v2').embed(['warmup'])); print('Model baked into image.')"

# ── Stage 6: offline image (model pre-baked, no internet needed at startup) ──
FROM app AS offline

COPY --from=model-download --chown=appuser:appuser /model-baked /model-baked
ENV FASTEMBED_CACHE_PATH=/model-baked
ENV HF_HUB_OFFLINE=1

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/status')"
