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
