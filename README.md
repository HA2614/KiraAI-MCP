# KiraAI-MCP

KiraAI is a local AI workbench for project analysis, learned coding skills, reviewable code changes, image assets, and invite-based project collaboration.

It runs as a Docker Compose app with:

- React frontend and Express backend
- PostgreSQL with pgvector
- Redis sessions and job state
- Codex CLI for AI/code execution
- KiraAI Learning for reusable skills and source knowledge
- Reviewable code proposals with Accept/Reject
- Multi-user projects with invite links

## One-Command Install

Production server, recommended behind a reverse proxy with TLS:

```bash
KIRAAI_PROFILE=production bash <(curl -fsSL https://raw.githubusercontent.com/HA2614/KiraAI-MCP/main/install.sh)
```

Production server on a private LAN where you want to open `http://SERVER-IP:4000` directly:

```bash
KIRAAI_PROFILE=production KIRAAI_BIND_HOST=0.0.0.0 bash <(curl -fsSL https://raw.githubusercontent.com/HA2614/KiraAI-MCP/main/install.sh)
```

Local/dev install:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/HA2614/KiraAI-MCP/main/install.sh)
```

The installer checks Ubuntu, installs Docker if needed, clones or updates the repo, writes the `.env`, runs Codex device login, builds the app, starts Docker Compose, and verifies `/api/health`.

Production profile enables auth, generates secrets, binds the app to `127.0.0.1:4000`, and uses safer sandbox defaults. Use Nginx, Caddy, Cloudflare Tunnel, or another TLS reverse proxy to expose it publicly.

Login uses a signed JWT in an HttpOnly cookie. Tokens expire after `AUTH_SESSION_TTL_MS` and are also invalidated when the app container restarts, so users must sign in again after a restart.

## Manual Local Start

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

For Docker Desktop with Windows drive mounts, keep:

```text
APP_USER=root
```

For Linux production deployments, use:

```text
APP_USER=node
```

## Codex Login

KiraAI uses Codex CLI for code jobs, analyzer runs, image generation through Codex, and skill extraction.

Interactive login inside Docker:

```bash
docker compose run --rm -it app /app/node_modules/.bin/codex login --device-auth
docker compose up -d
```

The default Codex home mount is:

```text
CODEX_HOME_HOST=./.codex-host
CODEX_HOME=/home/node/.codex
```

If sessions were created with the wrong user, fix the host folder ownership and restart the app.

## First Use

1. Install and start KiraAI.
2. Complete Codex device login.
3. In production, create or use the first admin user from the installer bootstrap.
4. Add learning sources in KiraAI Learning.
5. Learn skills from those sources.
6. Create or import a project.
7. Use Kira Code with one prompt for code, image, or full-stack structure work.

By default, code jobs require learned KiraAI skills:

```text
CODE_JOB_REQUIRE_LEARNED_SKILLS=true
```

This keeps Codex from acting as a plain fallback writer when the server has not learned any useful skills yet.

## Core Workflows

- Kira Code: one prompt box for code changes, image assets, and full-stack structure proposals.
- Accept/Reject: generated file changes stay reviewable before they are applied.
- KiraAI Learning: add GitHub or website sources, learn skills, inspect jobs, export source lists.
- Projects: each user has a personal workspace and can invite collaborators to shared projects.
- Users: admins can create user/admin accounts from Settings.
- Analyzer: inspect codebases and generate project context.
- Explorer: browse project files with workspace and symlink safety checks.

## Useful Commands

```bash
docker compose ps
docker compose logs -f app
docker compose restart app
docker compose down
curl http://localhost:4000/api/health
```

Quality checks:

```bash
npm --workspace backend run check
npm --workspace backend run qa:code-response
npm --workspace backend run qa:security
npm --workspace backend run qa:multi-user
npm --workspace backend run qa:skill-gate
npm --workspace backend run qa:ml
npm --workspace frontend run build
```

## Installer Options

```bash
KIRAAI_PROFILE=production
KIRAAI_INSTALL_DIR="$HOME/apps/KiraAI-MCP"
KIRAAI_REPO_URL="https://github.com/HA2614/KiraAI-MCP.git"
KIRAAI_BRANCH=main
KIRAAI_BIND_HOST=0.0.0.0
KIRAAI_SKIP_CODEX_LOGIN=1
```

Production install with explicit public URL and first admin:

```bash
KIRAAI_PROFILE=production \
KIRAAI_PUBLIC_URL="https://kiraai.example.com" \
KIRAAI_ADMIN_EMAIL="admin@example.com" \
bash <(curl -fsSL https://raw.githubusercontent.com/HA2614/KiraAI-MCP/main/install.sh)
```

## Security Notes

- Do not expose local/dev mode directly to the public internet.
- Production mode enables login, secure sessions, Origin checks, rate limits, and safer Codex sandboxes.
- Production binds to `127.0.0.1:4000` by default so a reverse proxy can handle HTTPS.
- Keep `.env`, `.codex-host`, Postgres data, Redis data, and workspace data private.
- Invite links are secret bearer links. Revoke unused invites when needed.

## Documentation

- `install.sh`: one-command Ubuntu installer.
- `installationguide.docx`: manual install notes and troubleshooting history.
- `README.local.md`: local working notes, ignored by git.
