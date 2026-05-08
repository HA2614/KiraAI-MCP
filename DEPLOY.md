# Deployment

KiraAI-MCP is designed to run with Docker Compose.

## First Run

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:4000
```

## Filesystem Mount

The default Compose file mounts:

```text
./workspace -> /workspace
```

To work on another folder, edit `.env`:

```text
HOST_WORKSPACE_ROOT=/absolute/path/to/projects
CONTAINER_FS_ROOT=/workspace
VITE_DEFAULT_ROOT=/workspace
```

On Windows:

```text
HOST_WORKSPACE_ROOT=C:/
```

The app can read and write inside the mounted folder.

## Services

- `app`: Node backend and React frontend
- `postgres`: pgvector database
- `redis`: cache and coordination

## Secrets

Set secrets in `.env` or in your deployment secret manager:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

Do not commit `.env`.

## Commands

```bash
docker compose config
docker compose build
docker compose up -d
docker compose logs -f app
docker compose down
docker compose down -v
```

Use `docker compose down -v` only when you want to remove database data.

## Validation

```bash
npm run qa
docker compose config
docker compose build
docker compose up -d
```

Then verify:

```text
http://localhost:4000
http://localhost:4000/api/health
```
