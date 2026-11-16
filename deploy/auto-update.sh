#!/usr/bin/env bash
# Auto-updater for Antigravity Chat UI on Ubuntu (invoked by antigravity-chat-updater.timer).
# Prefers pre-built GitHub Actions Release bundle ("latest") so the Oracle VM performs
# zero tsc/vite builds. Falls back gracefully to git pull + local build if unconfigured.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
APP_USER="${APP_USER:-antigravity}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
RELEASE_TAG="${RELEASE_TAG:-latest}"
SERVICE_NAME="${SERVICE_NAME:-antigravity-chat.service}"
ENV_FILE="${ENV_FILE:-/etc/antigravity-chat/env}"
LOCK_FILE="${LOCK_FILE:-/run/antigravity-chat-updater.lock}"

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"

if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

if [[ ! -d "${APP_DIR}" ]]; then
  echo "[auto-update] Skip: ${APP_DIR} does not exist."
  exit 0
fi

# Prevent overlapping timer runs
if command -v flock >/dev/null 2>&1; then
  if ! mkdir -p "$(dirname "${LOCK_FILE}")" 2>/dev/null; then
    LOCK_FILE="/tmp/antigravity-chat-updater.lock"
  fi
  exec 9>"${LOCK_FILE}"
  if ! flock -n 9; then
    echo "[auto-update] Another update is already running; skipping."
    exit 0
  fi
fi

REPO_OWNER="$(stat -c '%U' "${APP_DIR}")"

run_as_owner() {
  if [[ "$(id -u)" -eq 0 ]] && [[ -n "${REPO_OWNER}" ]] && [[ "${REPO_OWNER}" != "root" ]] && id "${REPO_OWNER}" >/dev/null 2>&1; then
    runuser -u "${REPO_OWNER}" -- env "PATH=${PATH}" "$@"
  else
    "$@"
  fi
}

git_repo() {
  run_as_owner git -c "safe.directory=${APP_DIR}" -C "${APP_DIR}" "$@"
}

infer_github_repo() {
  if [[ -n "${GITHUB_REPO:-}" ]]; then
    echo "${GITHUB_REPO}"
    return 0
  fi
  if [[ -d "${APP_DIR}/.git" ]]; then
    local url
    url="$(git_repo remote get-url "${REMOTE_NAME}" 2>/dev/null || true)"
    if [[ "${url}" =~ github\.com[:/]([^/]+/[^/.]+)(\.git)?$ ]]; then
      echo "${BASH_REMATCH[1]}"
      return 0
    fi
  fi
  return 1
}

try_prebuilt_release_update() {
  local gh_repo token tmp_dir
  gh_repo="$(infer_github_repo || true)"
  token="${GITHUB_READ_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"

  if [[ -z "${gh_repo}" ]] || [[ -z "${token}" ]]; then
    return 1
  fi

  tmp_dir="$(mktemp -d /tmp/acy-release-XXXXXX)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  local release_json="${tmp_dir}/release.json"
  if ! curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${gh_repo}/releases/tags/${RELEASE_TAG}" \
    -o "${release_json}"; then
    echo "[auto-update] Release lookup failed; falling back if possible."
    return 1
  fi

  local urls
  urls="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
assets = {a["name"]: a["url"] for a in data.get("assets", [])}
for name in ("BUILD_INFO.json", "antigravity-chat-bundle.tar.gz", "antigravity-chat-bundle.tar.gz.sha256"):
    print(assets.get(name, ""))
' "${release_json}")"

  local info_url bundle_url sha_url
  info_url="$(printf '%s\n' "${urls}" | sed -n '1p')"
  bundle_url="$(printf '%s\n' "${urls}" | sed -n '2p')"
  sha_url="$(printf '%s\n' "${urls}" | sed -n '3p')"

  if [[ -z "${info_url}" ]] || [[ -z "${bundle_url}" ]] || [[ -z "${sha_url}" ]]; then
    echo "[auto-update] Prebuilt release assets incomplete; falling back."
    return 1
  fi

  curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/octet-stream" \
    "${info_url}" -o "${tmp_dir}/BUILD_INFO.json"

  local remote_sha local_sha=""
  remote_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commitSha",""))' "${tmp_dir}/BUILD_INFO.json")"
  if [[ -f "${APP_DIR}/BUILD_INFO.json" ]]; then
    local_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("commitSha",""))' "${APP_DIR}/BUILD_INFO.json" 2>/dev/null || true)"
  elif [[ -d "${APP_DIR}/.git" ]]; then
    local_sha="$(git_repo rev-parse HEAD 2>/dev/null || true)"
  fi

  if [[ -z "${remote_sha}" ]]; then
    return 1
  fi
  if [[ "${remote_sha}" == "${local_sha}" ]]; then
    return 0
  fi

  echo "[auto-update] Prebuilt Actions bundle update detected: ${local_sha:0:8} -> ${remote_sha:0:8}"

  curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/octet-stream" \
    "${sha_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256"
  curl -fsSL \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/octet-stream" \
    "${bundle_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz"

  local apply_flags=()
  if [[ -d "${APP_DIR}/.git" ]]; then
    if [[ -n "$(git_repo status --porcelain)" ]]; then
      echo "[auto-update] Working tree in ${APP_DIR} has uncommitted changes; skipping."
      return 0
    fi
    if git_repo fetch --quiet "${REMOTE_NAME}" "${BRANCH}" && git_repo merge --ff-only "${remote_sha}" >/dev/null 2>&1; then
      apply_flags+=(--runtime-only)
    fi
  fi

  bash "${APP_DIR}/deploy/apply-bundle.sh" \
    "${tmp_dir}/antigravity-chat-bundle.tar.gz" \
    --sha256 "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256" \
    "${apply_flags[@]}"

  echo "[auto-update] Applied prebuilt Actions bundle (${remote_sha:0:8})."
  return 0
}

# 1. Try fast prebuilt Actions Release bundle first
if [[ "${DEPLOY_MODE:-auto}" != "git" ]] && try_prebuilt_release_update; then
  exit 0
fi

# 2. Fallback: git pull + local build (when GITHUB_READ_TOKEN isn't configured)
if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[auto-update] Skip: neither GITHUB_READ_TOKEN prebuilt release nor .git checkout is available in ${APP_DIR}."
  exit 0
fi

if [[ -n "$(git_repo status --porcelain)" ]]; then
  echo "[auto-update] Working tree in ${APP_DIR} has uncommitted changes; skipping automatic pull."
  exit 0
fi

git_repo fetch --quiet "${REMOTE_NAME}" "${BRANCH}"

LOCAL_SHA="$(git_repo rev-parse HEAD)"
REMOTE_SHA="$(git_repo rev-parse "${REMOTE_NAME}/${BRANCH}")"

if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" ]]; then
  exit 0
fi

if ! git_repo merge-base --is-ancestor "${LOCAL_SHA}" "${REMOTE_SHA}"; then
  echo "[auto-update] ERROR: ${LOCAL_SHA:0:8} is not an ancestor of ${REMOTE_NAME}/${BRANCH} (${REMOTE_SHA:0:8})."
  exit 1
fi

echo "[auto-update] Git fallback update detected: ${LOCAL_SHA:0:8} -> ${REMOTE_SHA:0:8}"

DEPS_CHANGED="$(git_repo diff --name-only "${LOCAL_SHA}" "${REMOTE_SHA}" -- package.json package-lock.json server/package.json web/package.json || true)"

git_repo pull --ff-only "${REMOTE_NAME}" "${BRANCH}"

if [[ -n "${DEPS_CHANGED}" ]] || [[ ! -d "${APP_DIR}/node_modules" ]]; then
  echo "[auto-update] Installing dependencies via npm ci..."
  run_as_owner npm --prefix "${APP_DIR}" ci --no-audit --no-fund
fi

echo "[auto-update] Building web and server bundles locally..."
run_as_owner npm --prefix "${APP_DIR}" run build

if command -v systemctl >/dev/null 2>&1; then
  echo "[auto-update] Restarting ${SERVICE_NAME}..."
  systemctl restart "${SERVICE_NAME}"
fi

echo "[auto-update] Updated successfully to ${REMOTE_SHA:0:8}."
