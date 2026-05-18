#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

KIRAAI_REPO_URL="${KIRAAI_REPO_URL:-https://github.com/HA2614/KiraAI-MCP.git}"
KIRAAI_BRANCH="${KIRAAI_BRANCH:-main}"
KIRAAI_SKIP_CODEX_LOGIN="${KIRAAI_SKIP_CODEX_LOGIN:-0}"

if [[ -n "${KIRAAI_INSTALL_DIR:-}" ]]; then
  INSTALL_DIR="$KIRAAI_INSTALL_DIR"
elif [[ -f "docker-compose.yml" && -f ".env.example" && -d ".git" ]]; then
  INSTALL_DIR="$(pwd -P)"
else
  INSTALL_DIR="$HOME/apps/KiraAI-MCP"
fi

TOTAL_STEPS=11
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

  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    printf '\n%s=%s\n' "$key" "$value" >> "$file"
  fi
}

write_env() {
  cd "$PROJECT_DIR"
  [[ -f ".env.example" ]] || fail ".env.example is missing."
  if [[ ! -f ".env" ]]; then
    cp .env.example .env
  fi

  set_env_value .env APP_BIND_HOST "0.0.0.0"
  set_env_value .env VITE_API_URL "/api"
  set_env_value .env HOST_WORKSPACE_ROOT "./workspace"
  set_env_value .env CONTAINER_FS_ROOT "/workspace"
  set_env_value .env CODEX_HOME_HOST "./.codex-host"
  set_env_value .env IMAGE_PROVIDER "codex_cli"
  set_env_value .env CODE_JOB_SANDBOX "danger-full-access"
  set_env_value .env CODEX_SUMMARY_SANDBOX "danger-full-access"
}

create_runtime_dirs() {
  cd "$PROJECT_DIR"
  mkdir -p workspace .codex-host
}

build_app_image() {
  cd "$PROJECT_DIR"
  docker_compose build app
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
  local value=""
  if [[ -f "$PROJECT_DIR/.env" ]]; then
    value="$(grep -E "^${key}=" "$PROJECT_DIR/.env" | tail -n 1 | cut -d= -f2- || true)"
  fi
  printf '%s' "$value"
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
  local server_ip
  app_port="$(env_value APP_HOST_PORT)"
  app_port="${app_port:-4000}"
  server_ip="$(detect_server_ip)"

  echo
  echo "KiraAI-MCP install complete."
  echo "Project: ${PROJECT_DIR}"
  echo "Open from this VM: http://localhost:${app_port}"
  echo "Open from your host browser: http://${server_ip}:${app_port}"
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
  run_step "Codex device-auth login" codex_device_login
  run_step "Start Docker Compose services" start_services
  run_step "Verify KiraAI health" verify_app
  finish_message
}

main "$@"
