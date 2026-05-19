#!/bin/sh
set -eu

APP_USER="${APP_USER:-node}"
CODEX_DIR="${CODEX_HOME:-/home/node/.codex}"
WORKSPACE_DIR="${FS_BASE_PATH:-/workspace}"

repair_dir() {
  dir="$1"
  label="$2"

  mkdir -p "$dir"

  # Prefer real ownership fixes. Some bind mounts, especially from Windows,
  # ignore chown but still allow chmod; the fallback below handles those.
  chown -R "$APP_USER:$APP_USER" "$dir" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$dir" 2>/dev/null || true

  if ! env KIRAAI_TEST_DIR="$dir" gosu "$APP_USER" sh -c 'touch "$KIRAAI_TEST_DIR/.kiraai-write-test" && rm -f "$KIRAAI_TEST_DIR/.kiraai-write-test"' 2>/dev/null; then
    chmod -R a+rwX "$dir" 2>/dev/null || true
  fi

  if ! env KIRAAI_TEST_DIR="$dir" gosu "$APP_USER" sh -c 'touch "$KIRAAI_TEST_DIR/.kiraai-write-test" && rm -f "$KIRAAI_TEST_DIR/.kiraai-write-test"' 2>/dev/null; then
    echo "Warning: $label root is not writable by $APP_USER: $dir" >&2
  fi
}

check_writable_dir() {
  dir="$1"
  label="$2"

  mkdir -p "$dir"
  chown "$APP_USER:$APP_USER" "$dir" 2>/dev/null || true
  chmod u+rwX,g+rwX "$dir" 2>/dev/null || true

  if ! env KIRAAI_TEST_DIR="$dir" gosu "$APP_USER" sh -c 'touch "$KIRAAI_TEST_DIR/.kiraai-write-test" && rm -f "$KIRAAI_TEST_DIR/.kiraai-write-test"' 2>/dev/null; then
    chmod a+rwX "$dir" 2>/dev/null || true
  fi

  if ! env KIRAAI_TEST_DIR="$dir" gosu "$APP_USER" sh -c 'touch "$KIRAAI_TEST_DIR/.kiraai-write-test" && rm -f "$KIRAAI_TEST_DIR/.kiraai-write-test"' 2>/dev/null; then
    echo "Warning: $label root is not writable by $APP_USER: $dir" >&2
  fi
}

codex_home_usable() {
  env KIRAAI_CODEX_HOME="$CODEX_DIR" gosu "$APP_USER" sh -c '
    mkdir -p "$KIRAAI_CODEX_HOME/sessions" &&
    touch "$KIRAAI_CODEX_HOME/sessions/.kiraai-write-test" &&
    rm -f "$KIRAAI_CODEX_HOME/sessions/.kiraai-write-test" &&
    { [ ! -f "$KIRAAI_CODEX_HOME/config.toml" ] || [ -r "$KIRAAI_CODEX_HOME/config.toml" ]; }
  ' 2>/dev/null
}

repair_codex_home() {
  mkdir -p "$CODEX_DIR/sessions"
  if codex_home_usable; then
    return 0
  fi

  repair_dir "$CODEX_DIR" "Codex home"
  chown -R "$APP_USER:$APP_USER" "$CODEX_DIR/sessions" 2>/dev/null || true
  chmod -R u+rwX,g+rwX "$CODEX_DIR/sessions" 2>/dev/null || true

  if ! codex_home_usable; then
    chmod -R a+rwX "$CODEX_DIR" 2>/dev/null || true
  fi

  if ! codex_home_usable; then
    echo "Fatal: Codex home is not usable by $APP_USER: $CODEX_DIR" >&2
    echo "Fix the host path from .env CODEX_HOME_HOST or choose a writable Codex home directory." >&2
    exit 1
  fi
}

check_writable_dir "$WORKSPACE_DIR" "Workspace"
repair_codex_home

exec gosu "$APP_USER" "$@"
