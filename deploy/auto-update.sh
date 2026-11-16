#!/usr/bin/env bash
# Auto-updater for Antigravity Chat UI on Ubuntu (invoked by antigravity-chat-updater.timer).
# Prefers pre-built GitHub Actions Release bundle (latest versioned Release by default,
# falling back gracefully to legacy "latest" mirror tag or git pull + local build).

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
APP_USER="${APP_USER:-antigravity}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
RELEASE_TAG="${RELEASE_TAG:-auto}"
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

  if [[ -z "${gh_repo}" ]]; then
    return 1
  fi

  tmp_dir="$(mktemp -d /tmp/acy-release-XXXXXX)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  local info_url="" bundle_url="" sha_url=""
  if [[ -n "${token}" ]]; then
    local release_json="${tmp_dir}/release.json"
    local api_urls=()
    if [[ "${RELEASE_TAG}" == "auto" ]] || [[ -z "${RELEASE_TAG}" ]]; then
      api_urls+=(
        "https://api.github.com/repos/${gh_repo}/releases/latest"
        "https://api.github.com/repos/${gh_repo}/releases/tags/latest"
      )
    else
      api_urls+=("https://api.github.com/repos/${gh_repo}/releases/tags/${RELEASE_TAG}")
    fi

    local fetched=0
    for api_url in "${api_urls[@]}"; do
      if curl -fsSL \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "${api_url}" \
        -o "${release_json}" 2>/dev/null; then
        fetched=1
        break
      fi
    done

    if [[ "${fetched}" -eq 0 ]]; then
      echo "[auto-update] Authenticated release lookup failed; falling back if possible."
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
      "${info_url}" -o "${tmp_dir}/BUILD_INFO.json" || return 1
  else
    # Public repo fast path (uses GitHub Release CDN directly, no API rate limit or PAT needed)
    local base_candidates=()
    if [[ "${RELEASE_TAG}" == "auto" ]] || [[ -z "${RELEASE_TAG}" ]]; then
      base_candidates+=(
        "https://github.com/${gh_repo}/releases/latest/download"
        "https://github.com/${gh_repo}/releases/download/latest"
      )
    else
      base_candidates+=("https://github.com/${gh_repo}/releases/download/${RELEASE_TAG}")
    fi

    local matched_base=""
    for base_dl in "${base_candidates[@]}"; do
      if curl -fsSL "${base_dl}/BUILD_INFO.json" -o "${tmp_dir}/BUILD_INFO.json" 2>/dev/null; then
        matched_base="${base_dl}"
        break
      fi
    done

    if [[ -z "${matched_base}" ]]; then
      return 1
    fi

    info_url="${matched_base}/BUILD_INFO.json"
    bundle_url="${matched_base}/antigravity-chat-bundle.tar.gz"
    sha_url="${matched_base}/antigravity-chat-bundle.tar.gz.sha256"
  fi

  local remote_meta remote_sha remote_version local_sha="" local_version=""
  remote_meta="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("commitSha","")); print(d.get("version",""))' "${tmp_dir}/BUILD_INFO.json" 2>/dev/null || true)"
  remote_sha="$(printf '%s\n' "${remote_meta}" | sed -n '1p')"
  remote_version="$(printf '%s\n' "${remote_meta}" | sed -n '2p')"

  if [[ -f "${APP_DIR}/BUILD_INFO.json" ]]; then
    local local_meta
    local_meta="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("commitSha","")); print(d.get("version",""))' "${APP_DIR}/BUILD_INFO.json" 2>/dev/null || true)"
    local_sha="$(printf '%s\n' "${local_meta}" | sed -n '1p')"
    local_version="$(printf '%s\n' "${local_meta}" | sed -n '2p')"
  elif [[ -d "${APP_DIR}/.git" ]]; then
    local_sha="$(git_repo rev-parse HEAD 2>/dev/null || true)"
  fi

  if [[ -z "${remote_sha}" ]]; then
    return 1
  fi
  if [[ "${remote_sha}" == "${local_sha}" ]]; then
    if [[ -z "${remote_version}" ]] || [[ -z "${local_version}" ]] || [[ "${remote_version}" == "${local_version}" ]]; then
      return 0
    fi
  fi

  local local_desc remote_desc
  local_desc="${local_version:+v${local_version} }(${local_sha:0:8})"
  remote_desc="${remote_version:+v${remote_version} }(${remote_sha:0:8})"
  echo "[auto-update] Prebuilt Actions bundle update detected: ${local_desc} -> ${remote_desc}"

  if [[ -n "${token}" ]]; then
    curl -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/octet-stream" \
      "${sha_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256"
    curl -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/octet-stream" \
      "${bundle_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz"
  else
    curl -fsSL "${sha_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256"
    curl -fsSL "${bundle_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz"
  fi

  local apply_flags=()
  if [[ -d "${APP_DIR}/.git" ]]; then
    if [[ -n "$(git_repo status --porcelain)" ]]; then
      echo "[auto-update] Working tree in ${APP_DIR} has uncommitted changes; skipping."
      return 0
    fi
    if git_repo fetch --quiet --force --tags "${REMOTE_NAME}" "${BRANCH}" && git_repo merge --ff-only "${remote_sha}" >/dev/null 2>&1; then
      apply_flags+=(--runtime-only)
    fi
  fi

  bash "${APP_DIR}/deploy/apply-bundle.sh" \
    "${tmp_dir}/antigravity-chat-bundle.tar.gz" \
    --sha256 "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256" \
    "${apply_flags[@]}"

  echo "[auto-update] Applied prebuilt Actions bundle ${remote_desc}."
  return 0
}

# 1. Try fast prebuilt Actions Release bundle first
if [[ "${DEPLOY_MODE:-auto}" != "git" ]] && try_prebuilt_release_update; then
  exit 0
fi

# 2. Fallback: git pull + local build (when GITHUB_READ_TOKEN isn't configured)
if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "[auto-update] Skip: neither prebuilt release nor .git checkout is available in ${APP_DIR}."
  exit 0
fi

if [[ -n "$(git_repo status --porcelain)" ]]; then
  echo "[auto-update] Working tree in ${APP_DIR} has uncommitted changes; skipping automatic pull."
  exit 0
fi

git_repo fetch --quiet --force --tags "${REMOTE_NAME}" "${BRANCH}"

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

FALLBACK_VERSION=""
FALLBACK_TAG=""
if [[ -f "${APP_DIR}/scripts/version.mjs" ]]; then
  VER_JSON="$(run_as_owner node "${APP_DIR}/scripts/version.mjs" resolve --cwd "${APP_DIR}" --sha "${REMOTE_SHA}" 2>/dev/null || true)"
  if [[ -n "${VER_JSON}" ]]; then
    FALLBACK_VERSION="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("version",""))' "${VER_JSON}" 2>/dev/null || true)"
    FALLBACK_TAG="$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("releaseTag",""))' "${VER_JSON}" 2>/dev/null || true)"
  fi
fi
if [[ -z "${FALLBACK_VERSION}" ]]; then
  FALLBACK_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("version","1.0.0"))' "${APP_DIR}/package.json" 2>/dev/null || echo "1.0.0")"
  FALLBACK_TAG="v${FALLBACK_VERSION}"
fi

echo "[auto-update] Building web and server bundles locally (v${FALLBACK_VERSION})..."
run_as_owner env VITE_APP_VERSION="${FALLBACK_VERSION}" VITE_APP_COMMIT_SHA="${REMOTE_SHA:0:8}" npm --prefix "${APP_DIR}" run build

if [[ -f "${APP_DIR}/scripts/version.mjs" ]]; then
  if [[ -f "${APP_DIR}/web/dist/sw.js" ]]; then
    run_as_owner node "${APP_DIR}/scripts/version.mjs" stamp-sw \
      --file "${APP_DIR}/web/dist/sw.js" \
      --version "${FALLBACK_VERSION}" \
      --sha "${REMOTE_SHA:0:8}" >/dev/null || true
  fi
  run_as_owner node "${APP_DIR}/scripts/version.mjs" write-build-info \
    --out "${APP_DIR}/BUILD_INFO.json" \
    --version "${FALLBACK_VERSION}" \
    --tag "${FALLBACK_TAG}" \
    --sha "${REMOTE_SHA}" \
    --files "${APP_DIR}/web/dist/index.html,${APP_DIR}/web/dist/sw.js,${APP_DIR}/server/dist/app.js" >/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1; then
  echo "[auto-update] Restarting ${SERVICE_NAME}..."
  systemctl restart "${SERVICE_NAME}"
fi

echo "[auto-update] Updated successfully to v${FALLBACK_VERSION} (${REMOTE_SHA:0:8})."
