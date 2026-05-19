FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ARG VITE_DEFAULT_ROOT=/workspace
ARG VITE_API_URL=/api
ENV VITE_DEFAULT_ROOT=$VITE_DEFAULT_ROOT
ENV VITE_API_URL=$VITE_API_URL
RUN npm --workspace frontend run build

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bubblewrap git gosu ripgrep \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /home/node/.codex /home/node/.claude /workspace
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node backend/package.json backend/package.json
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node backend ./backend
COPY --chown=node:node desktop ./desktop
COPY --chown=node:node --from=build /app/frontend/dist ./frontend/dist
COPY --chown=root:root backend/docker-entrypoint.sh ./backend/docker-entrypoint.sh
RUN chmod +x ./backend/docker-entrypoint.sh \
  && chown -R node:node /home/node/.codex /home/node/.claude /workspace
ENTRYPOINT ["./backend/docker-entrypoint.sh"]
EXPOSE 4000
CMD ["sh", "-c", "node backend/src/migrate.js && node backend/src/server.js"]
