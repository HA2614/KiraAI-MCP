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

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bubblewrap git ripgrep \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY backend ./backend
COPY desktop ./desktop
COPY --from=build /app/frontend/dist ./frontend/dist
EXPOSE 4000
CMD ["sh", "-c", "node backend/src/migrate.js && node backend/src/server.js"]
