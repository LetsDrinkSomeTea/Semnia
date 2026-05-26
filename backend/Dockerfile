FROM python:3.12-slim

WORKDIR /backend

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Model is downloaded JIT on first start and cached in the semnia-model-cache volume
ENV FASTEMBED_CACHE_PATH=/model-cache

COPY app/ app/

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
