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

If host ports conflict, edit `.env`:

```text
APP_HOST_PORT=4000
POSTGRES_HOST_PORT=5432
REDIS_HOST_PORT=6379
```

## Codex Authentication

Docker installs the Codex CLI inside the app image. You do not need VS Code or a Codex extension.

KiraAI Code Worker and Codex based learning still need a Codex login. The Compose file mounts `CODEX_HOME_HOST` to `/root/.codex` inside the container.

Use an existing host login:

```text
CODEX_HOME_HOST=C:/Users/your-user/.codex
```

Or create a container-backed login:

```bash
mkdir .codex-host
docker compose run --rm -it app /app/node_modules/.bin/codex login
docker compose up --build
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
CODE_JOB_TIMEOUT_MS=900000
IMAGE_PROVIDER=codex_cli
```

Do not commit `.env`.

With the default Docker setup, Codex login is required for Code Worker, Analyzer, image generation, and ML skill extraction. OpenAI keys are optional unless you configure OpenAI as the active provider or embedding provider.

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
