# KiraAI-MCP

KiraAI-MCP is a local project workspace for planning, codebase analysis, file exploration, machine learning assisted prompt context, and reviewable code proposals.

The default deployment uses Docker Compose and starts:

- KiraAI app: Node backend serving the React frontend
- Postgres with pgvector
- Redis

## Prerequisites

- Docker and Docker Compose
- Optional: Node.js 22 for local development
- Optional: a Codex CLI login directory if you want Codex CLI based code work inside Docker

## Quick Start

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:4000
```

The app is bound to localhost by default. The Docker setup mounts `./workspace` from this repo into the app container at `/workspace`.

## Working On Projects

Place projects inside `./workspace`, or set this in `.env`:

```text
HOST_WORKSPACE_ROOT=/absolute/path/to/projects
CONTAINER_FS_ROOT=/workspace
VITE_DEFAULT_ROOT=/workspace
```

On Windows you can use a path such as:

```text
HOST_WORKSPACE_ROOT=C:/
```

Keep the app private unless you intentionally want another machine to access your local filesystem through KiraAI.

## Configuration

Copy `.env.example` to `.env` and adjust values as needed.

Common settings:

```text
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
CODE_AI_MODEL=gpt-5.5
ML_MIND_ENABLED=true
ML_AI_PROVIDER=codex_cli
ML_EMBEDDING_PROVIDER=local_hash
```

Do not commit `.env`.

## Local Development

```bash
npm ci
npm run dev
```

Backend only:

```bash
npm --workspace backend run dev
```

Frontend only:

```bash
npm --workspace frontend run dev
```

## Quality Checks

Run the full check before publishing changes:

```bash
npm run qa
```

This applies the schema, checks backend syntax, runs the KiraAI prompt-selection QA suite, exercises the website learning fixture, and builds the frontend.

## Useful Commands

```bash
docker compose up --build
docker compose up -d
docker compose logs -f app
docker compose down
docker compose down -v
```

`docker compose down -v` removes database volumes.

## Services

- `app`: Backend API and built frontend
- `postgres`: Project, analysis, job, and ML storage
- `redis`: Cache and coordination

## Public Repo Safety

Before pushing:

```bash
git status --short
npm run qa
docker compose config
```

Confirm these are not staged:

- `.env`
- `.claude/`
- `.codex-host/`
- `node_modules/`
- `frontend/dist/`
- local workspace content under `workspace/`
