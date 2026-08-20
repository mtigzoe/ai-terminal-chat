# Backend-only image for the Flask / Python API.
# The React frontend and Electron shell continue to run on the host.
# Ollama is expected to run outside this container (see README).

FROM python:3.12-slim

WORKDIR /app

# System packages used by some tools (git status, etc.) and healthchecks.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        curl \
        git \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies first for better layer caching.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application code (tests are excluded via .dockerignore).
COPY . .

# Non-root user for a more production-oriented default.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app
USER appuser

# Default listen settings for containers; override via environment.
ENV HOST=0.0.0.0 \
    PORT=9000 \
    PROVIDER=ollama \
    OLLAMA_BASE_URL=http://host.docker.internal:11434/v1 \
    OLLAMA_MODEL=llama3.1 \
    PYTHONUNBUFFERED=1

EXPOSE 9000

# Lightweight readiness check against the Flask process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/providers" >/dev/null || exit 1

CMD ["python", "app.py"]
