# ── Stage 1: build React frontend ───────────────────────────────────────────
FROM node:20-alpine AS frontend

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --frozen-lockfile 2>/dev/null || npm install
COPY frontend/ .
RUN npm run build

# ── Stage 2: Python backend (usable standalone via --target backend) ─────────
FROM python:3.12-slim AS backend

WORKDIR /backend

RUN apt-get update && apt-get install -y --no-install-recommends gcc \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

ENV FASTEMBED_CACHE_PATH=/model-cache

COPY backend/app/ app/

# ── Stage 3: combined image ──────────────────────────────────────────────────
FROM backend AS app

ENV FRONTEND_DIR=/app/frontend

COPY --from=frontend /app/dist /app/frontend

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# ── Stage 4: offline image (model pre-baked, no internet needed at startup) ──
FROM app AS offline

# Separate path so a mounted model-cache volume doesn't shadow the baked model
ENV FASTEMBED_CACHE_PATH=/model-baked
# Download happens here — HF_HUB_OFFLINE must NOT be set yet
RUN python -c "from fastembed import TextEmbedding; list(TextEmbedding('sentence-transformers/paraphrase-multilingual-mpnet-base-v2').embed(['warmup'])); print('Model baked into image.')"
# Set AFTER download: prevents huggingface_hub from checking for revision updates at runtime
ENV HF_HUB_OFFLINE=1
