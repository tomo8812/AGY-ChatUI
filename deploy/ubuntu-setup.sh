#!/usr/bin/env bash
# Setup helper for Oracle Cloud Always Free Ubuntu (ARM64 A1.Flex 2 OCPU / 12 GB recommended, x86_64 supported).
# Safe and idempotent. Run as root or with sudo on a fresh Ubuntu 22.04 / 24.04 server.

set -euo pipefail

APP_USER="${APP_USER:-antigravity}"
APP_DIR="${APP_DIR:-/opt/antigravity-chat}"
DATA_DIR="${DATA_DIR:-/var/lib/antigravity-chat}"
# Keep 0 by default on 2 OCPU hosts to avoid disk bloat & CPU spikes; set 1 only if .pptx PDF conversion is needed
INSTALL_LIBREOFFICE="${INSTALL_LIBREOFFICE:-0}"

echo "==> [1/6] Installing base OS packages (python3, poppler-utils, bubblewrap, curl, ca-certificates)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  gnupg \
  git \
  python3 \
  poppler-utils \
  bubblewrap \
  acl

if [[ "${INSTALL_LIBREOFFICE}" == "1" ]]; then
  echo "==> Installing headless LibreOffice for optional PPTX/XLS/DOC -> PDF preview conversion..."
  apt-get install -y --no-install-recommends libreoffice-impress libreoffice-writer libreoffice-calc libreoffice-common fonts-noto-cjk
fi

echo "==> [2/6] Checking Node.js 24 LTS..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/v//' | cut -d. -f1)" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v
npm -v

echo "==> [3/6] Checking official Antigravity CLI (agy)..."
if ! command -v agy >/dev/null 2>&1; then
  echo "INFO: 'agy' binary not found in system PATH (/usr/local/bin:/usr/bin:/bin)."
  echo "Install the official unmodified Google Antigravity CLI for $(dpkg --print-architecture):"
  echo "  curl -fsSL https://antigravity.google/cli/install.sh | bash"
  echo "  (If installed under ~/.local/bin or ~/.antigravity/bin, symlink it to /usr/local/bin/agy"
  echo "   or set AGY_BIN=/full/path/to/agy inside /etc/antigravity-chat/env for systemd.)"
fi

echo "==> [4/6] Creating dedicated system user, directories, and persistent SESSION_SECRET..."
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/${APP_USER}" --shell /bin/bash "${APP_USER}"
fi

if [[ ! -d "${APP_DIR}" ]]; then
  mkdir -p "${APP_DIR}"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}"
fi
mkdir -p "${DATA_DIR}/profiles" "${DATA_DIR}/workspaces" "${DATA_DIR}/projects" "${DATA_DIR}/uploads" "${DATA_DIR}/artifacts-cache"
chown -R "${APP_USER}:${APP_USER}" "${DATA_DIR}"
chmod 700 "${DATA_DIR}" "${DATA_DIR}/profiles" "${DATA_DIR}/workspaces" "${DATA_DIR}/projects"

mkdir -p /etc/antigravity-chat
chmod 700 /etc/antigravity-chat
if [[ ! -f /etc/antigravity-chat/env ]]; then
  SESSION_SECRET_VAL="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
  printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET_VAL}" > /etc/antigravity-chat/env
  chmod 600 /etc/antigravity-chat/env
  echo "Created /etc/antigravity-chat/env with persistent SESSION_SECRET."
fi

echo "==> [5/6] Configuring optional 2GB swap (critical on VM.Standard.E2.1.Micro 1GB RAM)..."
TOTAL_RAM_KB="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
if [[ "${TOTAL_RAM_KB}" -lt 2200000 ]] && [[ ! -f /swapfile ]]; then
  echo "Detected <=2GB RAM (${TOTAL_RAM_KB} kB). Creating 2GB /swapfile..."
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> [6/6] Final notes for Oracle Always Free Ubuntu + GitHub Actions + Tailscale:"
echo "Option A (Recommended, zero VM build): Deploy prebuilt bundle via GitHub Actions:"
echo "  - Enable GitHub Actions Tailscale Push (ENABLE_TAILSCALE_DEPLOY=true) OR set"
echo "    GITHUB_READ_TOKEN=<fine-grained Contents:Read PAT> in /etc/antigravity-chat/env"
echo "    so antigravity-chat-updater.timer downloads the prebuilt CI release bundle."
echo "Option B (Local build fallback): Clone & build in ${APP_DIR}: npm ci && npm run build"
echo ""
echo "Install systemd units:"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat.service /etc/systemd/system/"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat-updater.service /etc/systemd/system/"
echo "  sudo cp ${APP_DIR}/deploy/antigravity-chat-updater.timer /etc/systemd/system/"
echo "Expose ONLY via Tailscale HTTPS (do NOT open port 3000 in OCI/iptables):"
echo "  curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up"
echo "  sudo tailscale serve --bg http://127.0.0.1:3000"
echo "Enable services:"
echo "  sudo systemctl daemon-reload"
echo "  sudo systemctl enable --now antigravity-chat"
echo "  sudo systemctl enable --now antigravity-chat-updater.timer"
