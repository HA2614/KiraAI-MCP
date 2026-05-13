# KiraAI-MCP

Local dashboard for project planning, codebase analysis, ML-assisted prompt context, and reviewable KiraAI Code proposals.

## Start

```bash
cp .env.example .env
docker compose up --build
```

Open:

```text
http://localhost:4000
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
docker compose up --build
```

## Codex Login

KiraAI Code Worker, Analyzer, and ML skill extraction use Codex CLI by default.

```bash
mkdir .codex-host
docker compose run --rm -it app /app/node_modules/.bin/codex login
docker compose up --build
```

If browser login fails inside Docker, log in on the host and set this in `.env`:

```text
CODEX_HOME_HOST=/path/to/.codex
```

## Useful Commands

```bash
docker compose up -d
docker compose logs -f app
docker compose restart app
docker compose down
npm run qa
```

## Known Issues

- Codex authentication is required for code jobs, analyzer runs, and ML skill extraction unless a local LLM provider is added.
- Large code prompts can take up to 15 minutes. Failed jobs can be retried from the same prompt.
- SQL migration and full-stack scaffold QA cases stay skipped until the ML Mind has learned enough SQL/API/scaffold skills.
- Keep the app localhost-bound unless you intentionally want another machine to access the mounted workspace.

## Current Tracker

- Add local LLM provider so KiraAI can run without Codex CLI.
- Train ML Mind on SQL, API routes, backend structure, and database migrations.
- Improve backend/API skill ranking after that training corpus exists.
