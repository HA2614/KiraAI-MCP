#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

KIRAAI_REPO_URL="${KIRAAI_REPO_URL:-https://github.com/HA2614/KiraAI-MCP.git}"
KIRAAI_BRANCH="${KIRAAI_BRANCH:-main}"
KIRAAI_SKIP_CODEX_LOGIN="${KIRAAI_SKIP_CODEX_LOGIN:-0}"
KIRAAI_PROFILE="${KIRAAI_PROFILE:-local}"
KIRAAI_BIND_HOST="${KIRAAI_BIND_HOST:-}"
KIRAAI_PUBLIC_URL="${KIRAAI_PUBLIC_URL:-}"
KIRAAI_ADMIN_EMAIL="${KIRAAI_ADMIN_EMAIL:-}"
KIRAAI_ADMIN_PASSWORD="${KIRAAI_ADMIN_PASSWORD:-}"

if [[ -n "${KIRAAI_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$KIRAAI_INSTALL_DIR"
elif [[ -f "docker-compose.yml" && -f ".env.example" && -d ".git" ]]; then
  INSTALL_DIR="$(pwd -P)"
else
  INSTALL_DIR="$HOME/apps/KiraAI-MCP"
fi

TOTAL_STEPS=12
CURRENT_STEP=0
LAST_STEP="startup"
PROJECT_DIR=""
declare -a SUDO_CMD=()
declare -a DOCKER_CMD=()

fail() {
  echo
  echo "ERROR: $*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  set +e
  echo
  echo "KiraAI install failed during: ${LAST_STEP}" >&2
  echo "Exit code: ${exit_code}" >&2
  if [[ -n "${PROJECT_DIR}" && -d "${PROJECT_DIR}" ]]; then
    echo
    echo "Useful debug commands:" >&2
    echo "  cd \"${PROJECT_DIR}\"" >&2
    echo "  docker compose ps" >&2
    echo "  docker compose logs --tail=120 app" >&2
    echo "  curl -v http://localhost:4000/api/health" >&2
  fi
  exit "$exit_code"
}
trap on_error ERR

print_progress() {
  local label="$1"
  local width=30
  local percent=$((CURRENT_STEP * 100 / TOTAL_STEPS))
  local filled=$((percent * width / 100))
  local empty=$((width - filled))
  local bar=""

  if (( filled > 0 )); then
    bar="$(printf '%*s' "$filled" '' | tr ' ' '#')"
  fi
  if (( empty > 0 )); then
    bar="${bar}$(printf '%*s' "$empty" '' | tr ' ' '-')"
  fi

  printf '[%s] %3d%% %s\n' "$bar" "$percent" "$label"
}

run_step() {
  local label="$1"
  shift
  LAST_STEP="$label"
  printf '\n[%d/%d] %s\n' "$((CURRENT_STEP + 1))" "$TOTAL_STEPS" "$label"
  "$@"
  CURRENT_STEP=$((CURRENT_STEP + 1))
  print_progress "$label"
}

docker_compose() {
  "${DOCKER_CMD[@]}" compose "$@"
}

random_secret() {
  local bytes="${1:-48}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 "$bytes" | tr '+/' '-_' | tr -d '=\n'
  else
    head -c "$bytes" /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n'
  fi
}

env_file_value() {
  local file="$1"
  local key="$2"
  local value=""
  if [[ -f "$file" ]]; then
    value="$(grep -E "^${key}=" "$file" | tail -n 1 | cut -d= -f2- || true)"
  fi
  value="${value%$'\r'}"
  if [[ "$value" == \'*\' && "$value" == *\' && "${#value}" -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \"*\" && "$value" == *\" && "${#value}" -ge 2 ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

env_render_value() {
  local key="$1"
  local value="$2"
  if [[ "$value" == *"'"* ]]; then
    fail "Cannot write ${key} to .env because the value contains a single quote."
  fi
  if [[ "$value" == *'$'* || "$value" == *'#'* || "$value" == *' '* || "$value" == *$'\t'* ]]; then
    printf "'%s'" "$value"
  else
    printf '%s' "$value"
  fi
}

url_origin() {
  local url="$1"
  printf '%s' "$url" | sed -E 's#^(https?://[^/]+).*#\1#'
}

preflight() {
  [[ -n "${BASH_VERSION:-}" ]] || fail "This installer must run with bash."
  [[ "$(uname -s)" == "Linux" ]] || fail "This installer targets Ubuntu Linux."
  [[ -r /etc/os-release ]] || fail "Cannot read /etc/os-release."

  # shellcheck disable=SC1091
  . /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    fail "Unsupported OS: ${PRETTY_NAME:-unknown}. Use Ubuntu 22.04 or 24.04."
  fi

  if [[ "$EUID" -eq 0 ]]; then
    SUDO_CMD=()
  else
    command -v sudo >/dev/null 2>&1 || fail "sudo is required."
    SUDO_CMD=(sudo)
    "${SUDO_CMD[@]}" -v
  fi

  mkdir -p "$(dirname "$INSTALL_DIR")"
  echo "Install directory: ${INSTALL_DIR}"
}

install_base_packages() {
  "${SUDO_CMD[@]}" apt-get update
  "${SUDO_CMD[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    ca-certificates \
    curl \
    git \
    gnupg \
    lsb-release
  curl -fsSI https://github.com >/dev/null
}

docker_compose_available() {
  command -v docker >/dev/null 2>&1 || return 1
  if docker compose version >/dev/null 2>&1; then
    return 0
  fi
  "${SUDO_CMD[@]}" docker compose version >/dev/null 2>&1
}

install_docker_if_needed() {
  if docker_compose_available; then
    echo "Docker Compose is already installed."
    if command -v systemctl >/dev/null 2>&1; then
      "${SUDO_CMD[@]}" systemctl enable --now docker || true
    fi
    return 0
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  local codename="${VERSION_CODENAME:-}"
  if [[ -z "$codename" ]]; then
    codename="$(lsb_release -cs)"
  fi
  [[ -n "$codename" ]] || fail "Cannot determine Ubuntu codename for Docker repository."

  "${SUDO_CMD[@]}" install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | "${SUDO_CMD[@]}" gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  "${SUDO_CMD[@]}" chmod a+r /etc/apt/keyrings/docker.gpg

  local arch
  arch="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$codename" \
    | "${SUDO_CMD[@]}" tee /etc/apt/sources.list.d/docker.list >/dev/null

  "${SUDO_CMD[@]}" apt-get update
  "${SUDO_CMD[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y \
    containerd.io \
    docker-buildx-plugin \
    docker-ce \
    docker-ce-cli \
    docker-compose-plugin

  if command -v systemctl >/dev/null 2>&1; then
    "${SUDO_CMD[@]}" systemctl enable --now docker
  fi

  if [[ "$EUID" -ne 0 ]] && getent group docker >/dev/null 2>&1; then
    "${SUDO_CMD[@]}" usermod -aG docker "$(id -un)" || true
  fi
}

configure_docker_access() {
  command -v docker >/dev/null 2>&1 || fail "docker was not found after installation."

  if docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DOCKER_CMD=(docker)
  elif "${SUDO_CMD[@]}" docker info >/dev/null 2>&1 && "${SUDO_CMD[@]}" docker compose version >/dev/null 2>&1; then
    DOCKER_CMD=("${SUDO_CMD[@]}" docker)
    echo "Using sudo for Docker in this session. Re-login later to use the docker group without sudo."
  else
    fail "Docker is installed, but the daemon is not reachable."
  fi

  docker_compose version >/dev/null
}

prepare_repo() {
  local parent
  parent="$(dirname "$INSTALL_DIR")"
  mkdir -p "$parent"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    PROJECT_DIR="$INSTALL_DIR"
    git -C "$PROJECT_DIR" fetch origin "$KIRAAI_BRANCH"
    git -C "$PROJECT_DIR" checkout "$KIRAAI_BRANCH"
    git -C "$PROJECT_DIR" pull --ff-only origin "$KIRAAI_BRANCH"
  elif [[ -e "$INSTALL_DIR" ]]; then
    if [[ -d "$INSTALL_DIR" && -z "$(ls -A "$INSTALL_DIR")" ]]; then
      git clone --branch "$KIRAAI_BRANCH" "$KIRAAI_REPO_URL" "$INSTALL_DIR"
      PROJECT_DIR="$INSTALL_DIR"
    else
      fail "Install directory exists but is not an empty directory or git repo: ${INSTALL_DIR}"
    fi
  else
    git clone --branch "$KIRAAI_BRANCH" "$KIRAAI_REPO_URL" "$INSTALL_DIR"
    PROJECT_DIR="$INSTALL_DIR"
  fi
}

set_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"
  local rendered
  local temp_file

  rendered="${key}=$(env_render_value "$key" "$value")"

  if grep -qE "^${key}=" "$file"; then
    temp_file="$(mktemp)"
    awk -v key="$key" -v line="$rendered" '
      BEGIN { replaced = 0 }
      $0 ~ "^" key "=" {
        if (!replaced) {
          print line
          replaced = 1
        }
        next
      }
      { print }
      END {
        if (!replaced) {
          print line
        }
      }
    ' "$file" > "$temp_file"
    cat "$temp_file" > "$file"
    rm -f "$temp_file"
  else
    printf '\n%s\n' "$rendered" >> "$file"
  fi
}

write_env() {
  cd "$PROJECT_DIR"
  [[ -f ".env.example" ]] || fail ".env.example is missing."
  if [[ ! -f ".env" ]]; then
    cp .env.example .env
  fi

  set_env_value .env VITE_API_URL "/api"
  set_env_value .env HOST_WORKSPACE_ROOT "./workspace"
  set_env_value .env CONTAINER_FS_ROOT "/workspace"
  set_env_value .env CODEX_HOME_HOST "./.codex-host"
  set_env_value .env IMAGE_PROVIDER "codex_cli"
  set_env_value .env IMAGE_CODEX_SANDBOX "workspace-write"
  set_env_value .env ML_ALLOW_PRIVATE_NETWORK_FETCHES "false"
  set_env_value .env CODE_JOB_REQUIRE_LEARNED_SKILLS "true"

  if [[ "$KIRAAI_PROFILE" == "production" ]]; then
    local session_secret
    local postgres_password
    local public_origin
    session_secret="$(env_file_value .env SESSION_SECRET)"
    postgres_password="$(env_file_value .env POSTGRES_PASSWORD)"
    if [[ -z "$session_secret" ]]; then
      session_secret="$(random_secret 48)"
    fi
    if [[ -z "$postgres_password" || "$postgres_password" == "postgres" ]]; then
      postgres_password="$(random_secret 32)"
    fi
    public_origin=""
    if [[ -n "$KIRAAI_PUBLIC_URL" ]]; then
      public_origin="$(url_origin "$KIRAAI_PUBLIC_URL")"
    fi

    set_env_value .env APP_BIND_HOST "${KIRAAI_BIND_HOST:-127.0.0.1}"
    set_env_value .env POSTGRES_PASSWORD "$postgres_password"
    set_env_value .env AUTH_ENABLED "true"
    set_env_value .env AUTH_BOOTSTRAP_EMAIL "$(env_file_value .env AUTH_BOOTSTRAP_EMAIL)"
    set_env_value .env INVITE_TTL_MS "604800000"
    set_env_value .env SESSION_SECRET "$session_secret"
    set_env_value .env AUTH_SESSION_TTL_MS "43200000"
    set_env_value .env AUTH_COOKIE_NAME "kiraai.jwt"
    set_env_value .env AUTH_COOKIE_SECURE "$([[ "$public_origin" == https://* ]] && echo true || echo false)"
    set_env_value .env CORS_ALLOWED_ORIGINS "$public_origin"
    set_env_value .env TRUST_PROXY "true"
    set_env_value .env RATE_LIMIT_WINDOW_MS "60000"
    set_env_value .env RATE_LIMIT_MAX "300"
    set_env_value .env AUTH_LOGIN_RATE_LIMIT_MAX "10"
    set_env_value .env EXPENSIVE_RATE_LIMIT_MAX "30"
    set_env_value .env CODE_JOB_MAX_ACTIVE "1"
    set_env_value .env ML_JOB_MAX_ACTIVE "1"
    set_env_value .env FS_MAX_READ_BYTES "1048576"
    set_env_value .env APP_USER "node"
    set_env_value .env CODE_JOB_SANDBOX "workspace-write"
    set_env_value .env CODEX_SUMMARY_SANDBOX "read-only"
    echo "Production profile enabled. App port binds to ${KIRAAI_BIND_HOST:-127.0.0.1}; use a reverse proxy/TLS for public access when internet-facing."
  else
    set_env_value .env APP_BIND_HOST "${KIRAAI_BIND_HOST:-0.0.0.0}"
    set_env_value .env AUTH_ENABLED "false"
    set_env_value .env POSTGRES_PASSWORD "postgres"
    set_env_value .env APP_USER "root"
    set_env_value .env CODE_JOB_SANDBOX "danger-full-access"
    set_env_value .env CODEX_SUMMARY_SANDBOX "danger-full-access"
  fi
}

create_runtime_dirs() {
  cd "$PROJECT_DIR"
  mkdir -p workspace .codex-host
  "${SUDO_CMD[@]}" chown -R "$(id -u):$(id -g)" workspace .codex-host 2>/dev/null || true
  chmod -R u+rwX workspace .codex-host
}

build_app_image() {
  cd "$PROJECT_DIR"
  docker_compose build app
}

configure_production_auth() {
  cd "$PROJECT_DIR"
  if [[ "$KIRAAI_PROFILE" != "production" ]]; then
    echo "Skipping production auth setup because KIRAAI_PROFILE=${KIRAAI_PROFILE}."
    return 0
  fi

  local existing_hash
  existing_hash="$(env_file_value .env AUTH_ADMIN_PASSWORD_HASH)"
  if [[ -n "$existing_hash" ]]; then
    if [[ -n "$KIRAAI_ADMIN_EMAIL" ]]; then
      set_env_value .env AUTH_BOOTSTRAP_EMAIL "$KIRAAI_ADMIN_EMAIL"
    elif [[ -z "$(env_file_value .env AUTH_BOOTSTRAP_EMAIL)" ]]; then
      set_env_value .env AUTH_BOOTSTRAP_EMAIL "admin@kiraai.local"
    fi
    echo "Existing AUTH_ADMIN_PASSWORD_HASH found; keeping current admin password."
    return 0
  fi

  local admin_email="$KIRAAI_ADMIN_EMAIL"
  if [[ -z "$admin_email" ]]; then
    admin_email="$(env_file_value .env AUTH_BOOTSTRAP_EMAIL)"
  fi
  if [[ -z "$admin_email" ]]; then
    if [[ ! -t 0 || ! -t 1 ]]; then
      fail "Production install needs KIRAAI_ADMIN_EMAIL or an interactive terminal."
    fi
    read -rp "KiraAI admin email: " admin_email
  fi
  [[ "$admin_email" == *@*.* ]] || fail "Admin email must be a valid email address."

  local password="$KIRAAI_ADMIN_PASSWORD"
  if [[ -z "$password" ]]; then
    if [[ ! -t 0 || ! -t 1 ]]; then
      fail "Production install needs KIRAAI_ADMIN_PASSWORD or an interactive terminal."
    fi
    local password_confirm=""
    read -rsp "Create KiraAI admin password: " password
    echo
    read -rsp "Confirm KiraAI admin password: " password_confirm
    echo
    [[ "$password" == "$password_confirm" ]] || fail "Admin passwords did not match."
  fi
  [[ "${#password}" -ge 10 ]] || fail "Admin password must be at least 10 characters."

  local hash
  hash="$(docker_compose run --rm -T --no-deps -e KIRAAI_ADMIN_PASSWORD="$password" app node backend/src/hashPassword.js --env)"
  set_env_value .env AUTH_BOOTSTRAP_EMAIL "$admin_email"
  set_env_value .env AUTH_ADMIN_PASSWORD_HASH "$hash"
  unset KIRAAI_ADMIN_PASSWORD
  echo "Admin email and password hash written to .env."
}

codex_device_login() {
  cd "$PROJECT_DIR"

  if [[ "$KIRAAI_SKIP_CODEX_LOGIN" == "1" ]]; then
    echo "Skipping Codex login because KIRAAI_SKIP_CODEX_LOGIN=1."
    return 0
  fi

  if [[ ! -t 0 || ! -t 1 ]]; then
    fail "Codex device login needs an interactive terminal. Use: bash <(curl -fsSL https://raw.githubusercontent.com/HA2614/KiraAI-MCP/main/install.sh)"
  fi

  echo "Codex device-auth login will open now. Finish login in the browser, then return here."
  docker_compose run --rm -it app /app/node_modules/.bin/codex login --device-auth
}

start_services() {
  cd "$PROJECT_DIR"
  docker_compose up -d
}

env_value() {
  local key="$1"
  env_file_value "$PROJECT_DIR/.env" "$key"
}

detect_server_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [[ -z "$ip" ]] && command -v ip >/dev/null 2>&1; then
    ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}' || true)"
  fi
  printf '%s' "${ip:-localhost}"
}

verify_app() {
  cd "$PROJECT_DIR"
  local app_port
  app_port="$(env_value APP_HOST_PORT)"
  app_port="${app_port:-4000}"

  for _ in $(seq 1 60); do
    if curl -fsS "http://localhost:${app_port}/api/health" >/tmp/kiraai-health.json 2>/dev/null; then
      echo "Health check: $(cat /tmp/kiraai-health.json)"
      return 0
    fi
    sleep 2
  done

  docker_compose ps || true
  docker_compose logs --tail=120 app || true
  fail "KiraAI did not pass health check at http://localhost:${app_port}/api/health."
}

finish_message() {
  local app_port
  local bind_host
  local server_ip
  app_port="$(env_value APP_HOST_PORT)"
  app_port="${app_port:-4000}"
  bind_host="$(env_value APP_BIND_HOST)"
  server_ip="$(detect_server_ip)"

  echo
  echo "KiraAI-MCP install complete."
  echo "Project: ${PROJECT_DIR}"
  echo "Profile: ${KIRAAI_PROFILE}"
  echo "Open from this VM: http://localhost:${app_port}"
  if [[ "$bind_host" == "0.0.0.0" ]]; then
    echo "Open from your LAN browser: http://${server_ip}:${app_port}"
  elif [[ "$KIRAAI_PROFILE" == "production" ]]; then
    if [[ -n "$KIRAAI_PUBLIC_URL" ]]; then
      echo "Public URL: ${KIRAAI_PUBLIC_URL}"
    else
      echo "Production mode binds to localhost. Put Nginx/Caddy/TLS in front before exposing it publicly."
    fi
  else
    echo "Open from your host browser: http://${server_ip}:${app_port}"
  fi
  echo
  echo "Useful commands:"
  echo "  cd \"${PROJECT_DIR}\""
  echo "  docker compose ps"
  echo "  docker compose logs -f app"
}

main() {
  echo "KiraAI-MCP one-command Ubuntu installer"
  echo "Repo: ${KIRAAI_REPO_URL}"
  echo "Branch: ${KIRAAI_BRANCH}"

  run_step "Preflight checks" preflight
  run_step "Install base packages" install_base_packages
  run_step "Install Docker if needed" install_docker_if_needed
  run_step "Configure Docker access" configure_docker_access
  run_step "Clone or update KiraAI repo" prepare_repo
  run_step "Write server .env values" write_env
  run_step "Create runtime directories" create_runtime_dirs
  run_step "Build KiraAI app image" build_app_image
  run_step "Configure production auth" configure_production_auth
  run_step "Codex device-auth login" codex_device_login
  run_step "Start Docker Compose services" start_services
  run_step "Verify KiraAI health" verify_app
  finish_message
}

main "$@"
