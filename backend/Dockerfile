FROM python:3.12-slim

WORKDIR /backend

RUN apt-get update && apt-get install -y --no-install-recommends gcc && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Bake ONNX model into image at build time (~115 MB, no PyTorch/CUDA needed)
RUN python -c "from fastembed import TextEmbedding; list(TextEmbedding('intfloat/multilingual-e5-small').embed(['warmup']))"

COPY app/ app/

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
