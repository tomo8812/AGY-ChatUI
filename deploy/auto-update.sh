#!/usr/bin/env bash
# Auto-updater for Antigravity Chat UI on Ubuntu (invoked by antigravity-chat-updater.timer).
# Updates strictly from SemVer versioned GitHub Releases (vX.Y.Z tags):
#   - RELEASE_TAG=auto (default): resolves the highest SemVer tag (vX.Y.Z) release
#   - RELEASE_TAG=vX.Y.Z: pins/rolls back to that exact release tag
# Falls back to git pull + local build only when RELEASE_TAG=auto and prebuilt bundles are unavailable.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
APP_USER="${APP_USER:-antigravity}"
REMOTE_NAME="${REMOTE_NAME:-origin}"
BRANCH="${BRANCH:-main}"
RELEASE_TAG="${RELEASE_TAG:-auto}"
SERVICE_NAME="${SERVICE_NAME:-antigravity-chat.service}"
ENV_FILE="${ENV_FILE:-/etc/antigravity-chat/env}"
LOCK_FILE="${LOCK_FILE:-/run/antigravity-chat-updater.lock}"
CURL_BIN="${CURL_BIN:-curl}"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
DATA_ROOT="${DATA_ROOT:-/var/lib/antigravity-chat}"
AGY_BIN="${AGY_BIN:-agy}"
AGY_MODE="${AGY_MODE:-}"
AGY_AUTO_UPDATE="${AGY_AUTO_UPDATE:-true}"
AGY_UPDATE_INTERVAL_SEC="${AGY_UPDATE_INTERVAL_SEC:-900}"
AGY_UPDATE_STAMP_FILE="${AGY_UPDATE_STAMP_FILE:-}"

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"

if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DATA_ROOT="${DATA_ROOT:-/var/lib/antigravity-chat}"
AGY_BIN="${AGY_BIN:-agy}"
AGY_MODE="${AGY_MODE:-}"
AGY_AUTO_UPDATE="${AGY_AUTO_UPDATE:-true}"
AGY_UPDATE_INTERVAL_SEC="${AGY_UPDATE_INTERVAL_SEC:-900}"
AGY_UPDATE_STAMP_FILE="${AGY_UPDATE_STAMP_FILE:-}"

RELEASE_TAG="${RELEASE_TAG:-auto}"
if [[ "${RELEASE_TAG}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  RELEASE_TAG="v${RELEASE_TAG}"
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

list_remote_semver_tags() {
  local gh_repo="$1"
  local raw_tags=""
  if [[ -d "${APP_DIR}/.git" ]]; then
    raw_tags="$(git_repo ls-remote --tags --refs "${REMOTE_NAME}" 'refs/tags/v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
  fi
  if [[ -z "${raw_tags}" ]]; then
    raw_tags="$(git ls-remote --tags --refs "https://github.com/${gh_repo}.git" 'refs/tags/v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null || true)"
  fi
  python3 -c '
import re, sys
tags = []
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) < 2:
        continue
    m = re.match(r"^refs/tags/(v(\d+)\.(\d+)\.(\d+))$", parts[1])
    if m:
        tags.append(((int(m.group(2)), int(m.group(3)), int(m.group(4))), m.group(1)))
for _, name in sorted(tags, key=lambda x: x[0], reverse=True):
    print(name)
' <<< "${raw_tags}"
}

try_prebuilt_release_update() {
  local gh_repo token tmp_dir
  gh_repo="$(infer_github_repo || true)"
  token="${GITHUB_READ_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"

  if [[ -z "${gh_repo}" ]]; then
    return 1
  fi

  tmp_dir="$(mktemp -d /tmp/acy-release-XXXXXX)"
  trap 'rm -rf "${tmp_dir:-}"; trap - RETURN' RETURN

  local selected_tag="" info_url="" bundle_url="" sha_url=""
  if [[ -n "${token}" ]]; then
    local release_json="${tmp_dir}/release.json"
    local parsed_release=""

    if [[ "${RELEASE_TAG}" == "auto" ]]; then
      if ! "${CURL_BIN}" -fsSL \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/${gh_repo}/releases?per_page=30" \
        -o "${release_json}" 2>/dev/null; then
        echo "[auto-update] Authenticated release list lookup failed."
        return 1
      fi
      parsed_release="$(python3 -c '
import json, re, sys
releases = json.load(open(sys.argv[1]))
if not isinstance(releases, list):
    sys.exit(0)
req = ("BUILD_INFO.json", "antigravity-chat-bundle.tar.gz", "antigravity-chat-bundle.tar.gz.sha256")
candidates = []
for rel in releases:
    if rel.get("draft") or rel.get("prerelease"):
        continue
    tag = str(rel.get("tag_name") or "")
    m = re.match(r"^v(\d+)\.(\d+)\.(\d+)$", tag)
    if not m:
        continue
    assets = {a["name"]: a["url"] for a in rel.get("assets", [])}
    if all(assets.get(k) for k in req):
        ver = (int(m.group(1)), int(m.group(2)), int(m.group(3)))
        candidates.append((ver, tag, assets[req[0]], assets[req[1]], assets[req[2]]))
if not candidates:
    sys.exit(0)
candidates.sort(key=lambda x: x[0], reverse=True)
_, tag, u0, u1, u2 = candidates[0]
print(tag)
print(u0)
print(u1)
print(u2)
' "${release_json}")"
    else
      if ! "${CURL_BIN}" -fsSL \
        -H "Authorization: Bearer ${token}" \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "https://api.github.com/repos/${gh_repo}/releases/tags/${RELEASE_TAG}" \
        -o "${release_json}" 2>/dev/null; then
        echo "[auto-update] Release tag ${RELEASE_TAG} lookup failed."
        return 1
      fi
      parsed_release="$(python3 -c '
import json, sys
data = json.load(open(sys.argv[1]))
assets = {a["name"]: a["url"] for a in data.get("assets", [])}
print(str(data.get("tag_name") or sys.argv[2]))
for name in ("BUILD_INFO.json", "antigravity-chat-bundle.tar.gz", "antigravity-chat-bundle.tar.gz.sha256"):
    print(assets.get(name, ""))
' "${release_json}" "${RELEASE_TAG}")"
    fi

    selected_tag="$(printf '%s\n' "${parsed_release}" | sed -n '1p')"
    info_url="$(printf '%s\n' "${parsed_release}" | sed -n '2p')"
    bundle_url="$(printf '%s\n' "${parsed_release}" | sed -n '3p')"
    sha_url="$(printf '%s\n' "${parsed_release}" | sed -n '4p')"

    if [[ -z "${selected_tag}" ]] || [[ -z "${info_url}" ]] || [[ -z "${bundle_url}" ]] || [[ -z "${sha_url}" ]]; then
      echo "[auto-update] No complete SemVer release bundle found."
      return 1
    fi

    "${CURL_BIN}" -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/octet-stream" \
      "${info_url}" -o "${tmp_dir}/BUILD_INFO.json" || return 1
  else
    # Public repo fast path: resolve SemVer version tags (vX.Y.Z) directly
    local matched_base=""
    if [[ "${RELEASE_TAG}" == "auto" ]]; then
      local tag_list
      tag_list="$(list_remote_semver_tags "${gh_repo}")"
      local tried=0
      while IFS= read -r candidate_tag; do
        [[ -z "${candidate_tag}" ]] && continue
        local candidate_base="https://github.com/${gh_repo}/releases/download/${candidate_tag}"
        if "${CURL_BIN}" -fsSL "${candidate_base}/BUILD_INFO.json" -o "${tmp_dir}/BUILD_INFO.json" 2>/dev/null; then
          selected_tag="${candidate_tag}"
          matched_base="${candidate_base}"
          break
        fi
        tried=$((tried + 1))
        [[ "${tried}" -ge 3 ]] && break
      done <<< "${tag_list}"

      # Fallback if git ls-remote could not enumerate tags, accepting only SemVer-tagged releases
      if [[ -z "${matched_base}" ]]; then
        if "${CURL_BIN}" -fsSL "https://github.com/${gh_repo}/releases/latest/download/BUILD_INFO.json" -o "${tmp_dir}/BUILD_INFO.json" 2>/dev/null; then
          local latest_meta_tag
          latest_meta_tag="$(python3 -c 'import json,re,sys; t=str(json.load(open(sys.argv[1])).get("tag","")); print(t if re.match(r"^v\d+\.\d+\.\d+$", t) else "")' "${tmp_dir}/BUILD_INFO.json" 2>/dev/null || true)"
          if [[ -n "${latest_meta_tag}" ]]; then
            selected_tag="${latest_meta_tag}"
            matched_base="https://github.com/${gh_repo}/releases/download/${selected_tag}"
          fi
        fi
      fi
    else
      local pinned_base="https://github.com/${gh_repo}/releases/download/${RELEASE_TAG}"
      if "${CURL_BIN}" -fsSL "${pinned_base}/BUILD_INFO.json" -o "${tmp_dir}/BUILD_INFO.json" 2>/dev/null; then
        selected_tag="${RELEASE_TAG}"
        matched_base="${pinned_base}"
      fi
    fi

    if [[ -z "${matched_base}" ]]; then
      return 1
    fi

    info_url="${matched_base}/BUILD_INFO.json"
    bundle_url="${matched_base}/antigravity-chat-bundle.tar.gz"
    sha_url="${matched_base}/antigravity-chat-bundle.tar.gz.sha256"
  fi

  local remote_meta remote_sha remote_version remote_tag local_sha="" local_version=""
  remote_meta="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("commitSha","")); print(d.get("version","")); print(d.get("tag",""))' "${tmp_dir}/BUILD_INFO.json" 2>/dev/null || true)"
  remote_sha="$(printf '%s\n' "${remote_meta}" | sed -n '1p')"
  remote_version="$(printf '%s\n' "${remote_meta}" | sed -n '2p')"
  remote_tag="$(printf '%s\n' "${remote_meta}" | sed -n '3p')"
  remote_tag="${remote_tag:-${selected_tag}}"

  if [[ "${RELEASE_TAG}" == "auto" ]] && [[ ! "${remote_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "[auto-update] Ignoring non-SemVer release tag '${remote_tag}'."
    return 1
  fi

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
  remote_desc="${remote_tag:-${remote_version:+v${remote_version}}} (${remote_sha:0:8})"
  echo "[auto-update] Release update detected [${selected_tag}]: ${local_desc} -> ${remote_desc}"

  if [[ -n "${token}" ]]; then
    "${CURL_BIN}" -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/octet-stream" \
      "${sha_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256" || return 1
    "${CURL_BIN}" -fsSL \
      -H "Authorization: Bearer ${token}" \
      -H "Accept: application/octet-stream" \
      "${bundle_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz" || return 1
  else
    "${CURL_BIN}" -fsSL "${sha_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz.sha256" || return 1
    "${CURL_BIN}" -fsSL "${bundle_url}" -o "${tmp_dir}/antigravity-chat-bundle.tar.gz" || return 1
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
    "${apply_flags[@]}" || return 1

  APP_RESTARTED=1
  echo "[auto-update] Applied release bundle ${remote_desc}."
  return 0
}

AGY_CLI_UPDATED=0
APP_RESTARTED=0

is_truthy() {
  case "${1,,}" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

resolve_agy_stamp_file() {
  if [[ -n "${AGY_UPDATE_STAMP_FILE}" ]]; then
    echo "${AGY_UPDATE_STAMP_FILE}"
    return 0
  fi
  if [[ -d "${DATA_ROOT}" ]] && [[ -w "${DATA_ROOT}" ]]; then
    echo "${DATA_ROOT}/.agy-update-check"
    return 0
  fi
  echo "/tmp/antigravity-chat-agy-update-check"
}

update_agy_cli() {
  if ! is_truthy "${AGY_AUTO_UPDATE:-true}"; then
    return 0
  fi
  if [[ "${AGY_MODE:-}" == "mock" ]]; then
    return 0
  fi

  local agy_path
  agy_path="$(command -v "${AGY_BIN}" 2>/dev/null || true)"
  if [[ -z "${agy_path}" ]] || [[ ! -x "${agy_path}" ]]; then
    return 0
  fi

  local stamp_file interval_sec now last_check=0
  stamp_file="$(resolve_agy_stamp_file)"
  interval_sec="${AGY_UPDATE_INTERVAL_SEC:-900}"
  if [[ ! "${interval_sec}" =~ ^[0-9]+$ ]]; then
    interval_sec=900
  fi
  now="$(date +%s)"

  if [[ "${interval_sec}" -gt 0 ]] && [[ -r "${stamp_file}" ]]; then
    last_check="$(cat "${stamp_file}" 2>/dev/null | tr -dc '0-9' || true)"
    last_check="${last_check:-0}"
    if [[ "${last_check}" -gt 0 ]] && (( now - last_check < interval_sec )); then
      return 0
    fi
  fi

  mkdir -p "$(dirname "${stamp_file}")" 2>/dev/null || true
  printf '%s\n' "${now}" > "${stamp_file}" 2>/dev/null || true

  local agy_real before_sha="" before_ver="" after_sha="" after_ver=""
  agy_real="$(readlink -f "${agy_path}" 2>/dev/null || echo "${agy_path}")"
  if [[ -f "${agy_real}" ]]; then
    before_sha="$(sha256sum "${agy_real}" 2>/dev/null | awk '{print $1}' || true)"
  fi
  before_ver="$(timeout 10 env -u AGY_CLI_DISABLE_AUTO_UPDATE "${agy_path}" --version </dev/null 2>/dev/null | tr -d '\r' | head -n 1 || true)"

  local update_out="" update_rc=0
  update_out="$(timeout 120 env -u AGY_CLI_DISABLE_AUTO_UPDATE "${agy_path}" update </dev/null 2>&1)" || update_rc=$?
  if [[ "${update_rc}" -ne 0 ]]; then
    echo "[auto-update] WARNING: agy update failed (exit ${update_rc}): ${update_out}"
    return 0
  fi

  local agy_real_after
  agy_real_after="$(readlink -f "${agy_path}" 2>/dev/null || echo "${agy_path}")"
  if [[ -f "${agy_real_after}" ]]; then
    after_sha="$(sha256sum "${agy_real_after}" 2>/dev/null | awk '{print $1}' || true)"
  fi
  after_ver="$(timeout 10 env -u AGY_CLI_DISABLE_AUTO_UPDATE "${agy_path}" --version </dev/null 2>/dev/null | tr -d '\r' | head -n 1 || true)"

  if { [[ -n "${after_sha}" ]] && [[ "${after_sha}" != "${before_sha}" ]]; } || { [[ -n "${after_ver}" ]] && [[ "${after_ver}" != "${before_ver}" ]]; }; then
    if [[ "$(id -u)" -eq 0 ]] && [[ -f "${agy_real_after}" ]]; then
      chmod 755 "${agy_real_after}" 2>/dev/null || true
    fi
    echo "[auto-update] Antigravity CLI (agy) updated: ${before_ver:-unknown} -> ${after_ver:-unknown}"
    AGY_CLI_UPDATED=1
  fi
  return 0
}

run_app_update() {
  # 1. Try fast prebuilt Actions Release bundle first
  if [[ "${DEPLOY_MODE:-auto}" != "git" ]] && try_prebuilt_release_update; then
    return 0
  fi

  # Do not bypass a pinned RELEASE_TAG by falling back to main branch HEAD
  if [[ "${RELEASE_TAG}" != "auto" ]]; then
    echo "[auto-update] Skip: pinned release tag ${RELEASE_TAG} bundle is not available."
    return 0
  fi

  # 2. Fallback: git pull + local build (when prebuilt SemVer releases are not yet available)
  if [[ ! -d "${APP_DIR}/.git" ]]; then
    echo "[auto-update] Skip: neither prebuilt SemVer release nor .git checkout is available in ${APP_DIR}."
    return 0
  fi

  if [[ -n "$(git_repo status --porcelain)" ]]; then
    echo "[auto-update] Working tree in ${APP_DIR} has uncommitted changes; skipping automatic pull."
    return 0
  fi

  git_repo fetch --quiet --force --tags "${REMOTE_NAME}" "${BRANCH}"

  local LOCAL_SHA REMOTE_SHA
  LOCAL_SHA="$(git_repo rev-parse HEAD)"
  REMOTE_SHA="$(git_repo rev-parse "${REMOTE_NAME}/${BRANCH}")"

  if [[ "${LOCAL_SHA}" == "${REMOTE_SHA}" ]]; then
    return 0
  fi

  if ! git_repo merge-base --is-ancestor "${LOCAL_SHA}" "${REMOTE_SHA}"; then
    echo "[auto-update] ERROR: ${LOCAL_SHA:0:8} is not an ancestor of ${REMOTE_NAME}/${BRANCH} (${REMOTE_SHA:0:8})."
    return 1
  fi

  echo "[auto-update] Git fallback update detected: ${LOCAL_SHA:0:8} -> ${REMOTE_SHA:0:8}"

  local DEPS_CHANGED
  DEPS_CHANGED="$(git_repo diff --name-only "${LOCAL_SHA}" "${REMOTE_SHA}" -- package.json package-lock.json server/package.json web/package.json || true)"

  git_repo pull --ff-only "${REMOTE_NAME}" "${BRANCH}"

  if [[ -n "${DEPS_CHANGED}" ]] || [[ ! -d "${APP_DIR}/node_modules" ]]; then
    echo "[auto-update] Installing dependencies via npm ci..."
    run_as_owner npm --prefix "${APP_DIR}" ci --no-audit --no-fund
  fi

  local FALLBACK_VERSION="" FALLBACK_TAG="" VER_JSON=""
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

  if command -v "${SYSTEMCTL_BIN}" >/dev/null 2>&1; then
    if "${SYSTEMCTL_BIN}" cat "${SERVICE_NAME}" >/dev/null 2>&1; then
      echo "[auto-update] Restarting ${SERVICE_NAME}..."
      "${SYSTEMCTL_BIN}" restart "${SERVICE_NAME}"
      APP_RESTARTED=1
    fi
  fi

  echo "[auto-update] Updated successfully to v${FALLBACK_VERSION} (${REMOTE_SHA:0:8})."
}

update_agy_cli
run_app_update

if [[ "${AGY_CLI_UPDATED}" -eq 1 ]] && [[ "${APP_RESTARTED}" -eq 0 ]]; then
  if command -v "${SYSTEMCTL_BIN}" >/dev/null 2>&1; then
    if "${SYSTEMCTL_BIN}" cat "${SERVICE_NAME}" >/dev/null 2>&1; then
      echo "[auto-update] Restarting ${SERVICE_NAME} to pick up updated Antigravity CLI..."
      "${SYSTEMCTL_BIN}" restart "${SERVICE_NAME}"
    fi
  fi
fi
