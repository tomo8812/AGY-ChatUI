#!/usr/bin/env bash
# Applies a pre-built Antigravity Chat UI runtime bundle (created by GitHub Actions)
# atomically into APP_DIR and restarts the systemd service. Zero compilation on VM.
#
# Usage:
#   apply-bundle.sh <bundle.tar.gz> [--sha256 <file>] [--runtime-only] [--no-restart]

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
APP_USER="${APP_USER:-antigravity}"
SERVICE_NAME="${SERVICE_NAME:-antigravity-chat.service}"

BUNDLE_PATH=""
SHA_PATH=""
RUNTIME_ONLY=0
NO_RESTART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sha256)
      SHA_PATH="${2:-}"
      shift 2
      ;;
    --runtime-only)
      RUNTIME_ONLY=1
      shift
      ;;
    --no-restart)
      NO_RESTART=1
      shift
      ;;
    -*)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
    *)
      if [[ -z "${BUNDLE_PATH}" ]]; then
        BUNDLE_PATH="$1"
      else
        echo "Unexpected argument: $1" >&2
        exit 2
      fi
      shift
      ;;
  esac
done

if [[ -z "${BUNDLE_PATH}" ]] || [[ ! -f "${BUNDLE_PATH}" ]]; then
  echo "[apply-bundle] Bundle file not found: ${BUNDLE_PATH}" >&2
  exit 1
fi

if [[ -z "${SHA_PATH}" ]] && [[ -f "${BUNDLE_PATH}.sha256" ]]; then
  SHA_PATH="${BUNDLE_PATH}.sha256"
fi

if [[ -n "${SHA_PATH}" ]]; then
  if [[ ! -f "${SHA_PATH}" ]]; then
    echo "[apply-bundle] SHA256 file not found: ${SHA_PATH}" >&2
    exit 1
  fi
  EXPECTED_SHA="$(awk '{print $1}' "${SHA_PATH}" | tr -d '[:space:]')"
  ACTUAL_SHA="$(sha256sum "${BUNDLE_PATH}" | awk '{print $1}' | tr -d '[:space:]')"
  if [[ -z "${EXPECTED_SHA}" ]] || [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
    echo "[apply-bundle] Checksum mismatch! expected=${EXPECTED_SHA} actual=${ACTUAL_SHA}" >&2
    exit 1
  fi
fi

mkdir -p "${APP_DIR}"
REPO_OWNER="$(stat -c '%U' "${APP_DIR}")"
if [[ "$(id -u)" -eq 0 ]] && [[ "${REPO_OWNER}" == "root" ]] && id "${APP_USER}" >/dev/null 2>&1; then
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}"
  REPO_OWNER="${APP_USER}"
fi

STAGE_DIR="${APP_DIR}/.bundle-staging.$$"
cleanup() {
  rm -rf "${STAGE_DIR}" "${APP_DIR}/.old-swap.$$" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "${STAGE_DIR}"
tar -xzf "${BUNDLE_PATH}" -C "${STAGE_DIR}"

if [[ "$(id -u)" -eq 0 ]] && [[ -n "${REPO_OWNER}" ]] && id "${REPO_OWNER}" >/dev/null 2>&1; then
  chown -R "${REPO_OWNER}:${REPO_OWNER}" "${STAGE_DIR}"
fi

swap_dir() {
  local src="$1"
  local dst="$2"
  local backup="${dst}.old.$$"
  if [[ ! -d "${src}" ]]; then
    return 0
  fi
  mkdir -p "$(dirname "${dst}")"
  if [[ -e "${dst}" ]]; then
    mv "${dst}" "${backup}"
  fi
  mv "${src}" "${dst}"
  rm -rf "${backup}"
}

NEW_LOCK_SHA=""
if [[ -f "${STAGE_DIR}/package-lock.json" ]]; then
  NEW_LOCK_SHA="$(sha256sum "${STAGE_DIR}/package-lock.json" | awk '{print $1}')"
fi
OLD_LOCK_SHA=""
if [[ -f "${APP_DIR}/.bundle-lock-sha256" ]]; then
  OLD_LOCK_SHA="$(cat "${APP_DIR}/.bundle-lock-sha256" | tr -d '[:space:]')"
fi

if [[ "${RUNTIME_ONLY}" -eq 0 ]]; then
  for manifest in package.json package-lock.json; do
    if [[ -f "${STAGE_DIR}/${manifest}" ]]; then
      mv -f "${STAGE_DIR}/${manifest}" "${APP_DIR}/${manifest}"
    fi
  done
  if [[ -f "${STAGE_DIR}/server/package.json" ]]; then
    mkdir -p "${APP_DIR}/server"
    mv -f "${STAGE_DIR}/server/package.json" "${APP_DIR}/server/package.json"
  fi
  if [[ -f "${STAGE_DIR}/web/package.json" ]]; then
    mkdir -p "${APP_DIR}/web"
    mv -f "${STAGE_DIR}/web/package.json" "${APP_DIR}/web/package.json"
  fi
  swap_dir "${STAGE_DIR}/server/scripts" "${APP_DIR}/server/scripts"
  swap_dir "${STAGE_DIR}/scripts" "${APP_DIR}/scripts"
  swap_dir "${STAGE_DIR}/deploy" "${APP_DIR}/deploy"
fi

if [[ -d "${STAGE_DIR}/node_modules" ]]; then
  if [[ -d "${APP_DIR}/node_modules" ]] && [[ -n "${NEW_LOCK_SHA}" ]] && [[ "${NEW_LOCK_SHA}" == "${OLD_LOCK_SHA}" ]]; then
    echo "[apply-bundle] Runtime dependencies unchanged; keeping existing node_modules."
  else
    echo "[apply-bundle] Updating server runtime node_modules..."
    swap_dir "${STAGE_DIR}/node_modules" "${APP_DIR}/node_modules"
    if [[ -n "${NEW_LOCK_SHA}" ]]; then
      printf '%s\n' "${NEW_LOCK_SHA}" > "${APP_DIR}/.bundle-lock-sha256"
    fi
  fi
fi

swap_dir "${STAGE_DIR}/server/dist" "${APP_DIR}/server/dist"
swap_dir "${STAGE_DIR}/web/dist" "${APP_DIR}/web/dist"

if [[ -f "${STAGE_DIR}/BUILD_INFO.json" ]]; then
  mv -f "${STAGE_DIR}/BUILD_INFO.json" "${APP_DIR}/BUILD_INFO.json"
fi

if [[ -d "${APP_DIR}/deploy" ]]; then
  chmod +x "${APP_DIR}/deploy/"*.sh 2>/dev/null || true
fi

if [[ "$(id -u)" -eq 0 ]] && [[ -n "${REPO_OWNER}" ]] && id "${REPO_OWNER}" >/dev/null 2>&1; then
  chown -R "${REPO_OWNER}:${REPO_OWNER}" "${APP_DIR}/web" "${APP_DIR}/server" "${APP_DIR}/scripts" 2>/dev/null || true
  chown "${REPO_OWNER}:${REPO_OWNER}" "${APP_DIR}/BUILD_INFO.json" "${APP_DIR}/.bundle-lock-sha256" 2>/dev/null || true
fi

if [[ "$(id -u)" -eq 0 ]]; then
  UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}"
  NEED_DAEMON_RELOAD=0

  if command -v bwrap >/dev/null 2>&1; then
    if [[ -r /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]] \
      && [[ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" == "1" ]] \
      && [[ -f /etc/apparmor.d/abi/4.0 ]] \
      && ! grep -RqsE '/usr/bin/bwrap' /etc/apparmor.d/ 2>/dev/null; then
      echo "[apply-bundle] Installing Ubuntu 24.04+ AppArmor userns profile for /usr/bin/bwrap..."
      cat <<'EOF' > /etc/apparmor.d/bwrap
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/bwrap>
}
EOF
      if command -v apparmor_parser >/dev/null 2>&1; then
        apparmor_parser -r -W /etc/apparmor.d/bwrap 2>/dev/null || true
      fi
    fi

    if [[ -f "${UNIT_FILE}" ]] && grep -qE '^NoNewPrivileges=true$' "${UNIT_FILE}"; then
      echo "[apply-bundle] Updating ${UNIT_FILE} (NoNewPrivileges=false) for bubblewrap userns transition..."
      sed -i 's/^NoNewPrivileges=true$/NoNewPrivileges=false/' "${UNIT_FILE}"
      NEED_DAEMON_RELOAD=1
    fi
  else
    echo "[apply-bundle] INFO: 'bwrap' (bubblewrap) is not installed; SANDBOX_MODE=auto will fall back cleanly until installed."
  fi

  if [[ -f "${UNIT_FILE}" ]] && grep -qE '^Environment=AGY_BIN=agy$' "${UNIT_FILE}"; then
    echo "[apply-bundle] Updating ${UNIT_FILE} (AGY_BIN=/usr/local/bin/agy) for single-binary consistency..."
    sed -i 's|^Environment=AGY_BIN=agy$|Environment=AGY_BIN=/usr/local/bin/agy|' "${UNIT_FILE}"
    NEED_DAEMON_RELOAD=1
  fi

  if [[ "${NEED_DAEMON_RELOAD}" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
    systemctl daemon-reload || true
  fi
fi

if [[ "${NO_RESTART}" -eq 0 ]] && command -v systemctl >/dev/null 2>&1; then
  if systemctl cat "${SERVICE_NAME}" >/dev/null 2>&1; then
    echo "[apply-bundle] Restarting ${SERVICE_NAME}..."
    systemctl restart "${SERVICE_NAME}"
  else
    echo "[apply-bundle] NOTE: ${SERVICE_NAME} is not installed yet; skipping restart."
  fi
fi

echo "[apply-bundle] Bundle deployed cleanly to ${APP_DIR}."
