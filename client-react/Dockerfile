# Production static build of the React/Vite web client.
# Electron is intentionally not containerized.
# The browser talks to the backend on the host (default localhost:9000);
# VITE_API_URL is baked in at build time.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html settings.html vite.config.js ./
COPY public ./public
COPY src ./src

# Browser-reachable API URL (not the Docker service name).
ARG VITE_API_URL=http://localhost:9000
ENV VITE_API_URL=$VITE_API_URL

RUN npm run build

# --- runtime ---
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
