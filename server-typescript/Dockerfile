# Backend image for the TypeScript / Hono API (API-compatible with server-python).
# Ollama is expected to run outside this container (see README).

FROM node:22-bookworm-slim AS build

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- runtime ---
FROM node:22-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system appuser \
    && useradd --system --gid appuser --create-home --shell /usr/sbin/nologin appuser

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER appuser

ENV HOST=0.0.0.0 \
    PORT=9000 \
    PROVIDER=ollama \
    OLLAMA_BASE_URL=http://host.docker.internal:11434/v1 \
    OLLAMA_MODEL=llama3.1 \
    NODE_ENV=production

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${PORT}/providers" >/dev/null || exit 1

CMD ["node", "dist/server.js"]
