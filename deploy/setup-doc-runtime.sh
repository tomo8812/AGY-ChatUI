#!/usr/bin/env bash
# Provisions an isolated, read-only document-processing runtime (Python venv, Node.js OOXML/PDF
# libraries, LibreOffice, Poppler, Pandoc, QPDF, Tesseract, and CJK/metric-compatible fonts)
# under DOC_RUNTIME_DIR (/opt/agy-doc-runtime by default) without polluting host Python/Node
# global directories or user home directories.
#
# Controlled by a single flag INSTALL_DOC_RUNTIME:
#   - auto (default): Base below 2.2 GiB, Compact below 3.5 GiB, Full otherwise
#   - 0 / false / no / off: always skips additional installation regardless of RAM (never removes existing packages)
#   - compact / 1 / true / yes / on: force Compact
#   - full: force Full, including Chromium and HTML rendering packages
#
# AGY-ChatUI mounts DOC_RUNTIME_DIR read-only into every profile's bubblewrap sandbox so all
# profiles share the same ready-to-run environment for Anthropic docx/pptx/xlsx/pdf skills.

set -euo pipefail

DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR:-/opt/agy-doc-runtime}"
INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME:-auto}"
ENV_FILE="${ENV_FILE:-/etc/antigravity-chat/env}"

if [[ -r "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

DOC_RUNTIME_DIR="${DOC_RUNTIME_DIR:-/opt/agy-doc-runtime}"
INSTALL_DOC_RUNTIME="${INSTALL_DOC_RUNTIME:-auto}"

case "${INSTALL_DOC_RUNTIME,,}" in
  0|false|no|off|base|base_chatui|none)
    echo "[doc-runtime] Skipping setup (INSTALL_DOC_RUNTIME=${INSTALL_DOC_RUNTIME})."
    exit 0
    ;;
  1|true|yes|on|compact|compact_doc_runtime) PROFILE=compact ;;
  full|full_runtime) PROFILE=full ;;
  *)
    TOTAL_RAM_KB="$(awk '/^MemTotal:/ {print $2; exit}' "${MEMINFO_FILE:-/proc/meminfo}" 2>/dev/null || true)"
    if [[ ! "${TOTAL_RAM_KB}" =~ ^[0-9]+$ ]]; then
      TOTAL_RAM_KB=0
    fi
    if (( TOTAL_RAM_KB >= 3670016 )); then
      PROFILE=full
    elif (( TOTAL_RAM_KB >= 2306868 )); then
      PROFILE=compact
    else
      PROFILE=base
    fi
    ;;
esac

if [[ "${PROFILE}" == base ]]; then
  echo "[doc-runtime] Skipping automatic setup on low-RAM host (${TOTAL_RAM_KB} kB). Set INSTALL_DOC_RUNTIME=compact or full to force."
  exit 0
fi

PYTHON_PACKAGES=(
  openpyxl
  pandas
  markitdown
  python-pptx
  python-docx
  Pillow
  defusedxml
  lxml
  pypdf
  pdfplumber
  reportlab
  pdf2image
  pytesseract
  pypdfium2
  matplotlib
)

NODE_PACKAGES=(
  docx
  pptxgenjs
  pdf-lib
  react
  react-dom
  react-icons
  sharp
)

APT_PACKAGES=(
  poppler-utils
  pandoc
  qpdf
  ffmpeg
  librsvg2-bin
  zip
  unzip
  python3
  python3-venv
  python-is-python3
  tesseract-ocr
  tesseract-ocr-jpn
  fontconfig
  fonts-noto-cjk
  fonts-liberation
  fonts-dejavu-core
  libreoffice-impress
  libreoffice-writer
  libreoffice-calc
  libreoffice-common
)

APT_OPTIONAL_FONTS=(
  fonts-crosextra-carlito
  fonts-crosextra-caladea
)

if [[ "${PROFILE}" == full ]]; then
  NODE_PACKAGES+=(playwright mermaid marked)
fi

SPEC_STRING="v3|${PROFILE}|apt=${APT_PACKAGES[*]}|py=${PYTHON_PACKAGES[*]}|node=${NODE_PACKAGES[*]}"
SPEC_SHA="$(printf '%s' "${SPEC_STRING}" | sha256sum | awk '{print $1}')"
STAMP_FILE="${DOC_RUNTIME_DIR}/.runtime-spec-sha256"

if [[ -f "${STAMP_FILE}" ]] && [[ "$(cat "${STAMP_FILE}" 2>/dev/null || true)" == "${SPEC_SHA}" ]]; then
  if [[ -x "${DOC_RUNTIME_DIR}/venv/bin/python3" ]] \
    && command -v ffmpeg >/dev/null 2>&1 \
    && command -v rsvg-convert >/dev/null 2>&1 \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/pptxgenjs" ]] \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/docx" ]] \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/sharp" ]] \
    && [[ -d "${DOC_RUNTIME_DIR}/node/node_modules/react-icons" ]] \
    && command -v pdftoppm >/dev/null 2>&1 \
    && command -v pandoc >/dev/null 2>&1 \
    && command -v qpdf >/dev/null 2>&1 \
    && command -v libreoffice >/dev/null 2>&1; then
    if [[ "${PROFILE}" == compact ]] || find "${DOC_RUNTIME_DIR}/playwright" -name chrome -type f -print -quit | grep -q .; then
      exit 0
    fi
  fi
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[doc-runtime] ERROR: Must run as root to install OS tools and ${DOC_RUNTIME_DIR}." >&2
  exit 1
fi

echo "==> [doc-runtime] Installing isolated document runtime into ${DOC_RUNTIME_DIR}..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"
apt-get install -y --no-install-recommends "${APT_OPTIONAL_FONTS[@]}" || true

if command -v fc-cache >/dev/null 2>&1; then
  fc-cache -f || true
fi

mkdir -p "${DOC_RUNTIME_DIR}"

echo "==> [doc-runtime] Provisioning isolated Python venv at ${DOC_RUNTIME_DIR}/venv..."
if [[ ! -x "${DOC_RUNTIME_DIR}/venv/bin/python3" ]]; then
  python3 -m venv "${DOC_RUNTIME_DIR}/venv"
fi
"${DOC_RUNTIME_DIR}/venv/bin/pip" install --no-cache-dir --upgrade pip
"${DOC_RUNTIME_DIR}/venv/bin/pip" install --no-cache-dir --upgrade "${PYTHON_PACKAGES[@]}"

echo "==> [doc-runtime] Provisioning isolated Node.js document packages at ${DOC_RUNTIME_DIR}/node..."
mkdir -p "${DOC_RUNTIME_DIR}/node"
cat <<'EOF' > "${DOC_RUNTIME_DIR}/node/package.json"
{
  "name": "agy-doc-runtime-node",
  "version": "1.0.0",
  "private": true
}
EOF
npm install --prefix "${DOC_RUNTIME_DIR}/node" --omit=dev --no-save --no-audit --no-fund "${NODE_PACKAGES[@]}"

if [[ "${PROFILE}" == full ]]; then
  PLAYWRIGHT_BROWSERS_PATH="${DOC_RUNTIME_DIR}/playwright" \
    "${DOC_RUNTIME_DIR}/node/node_modules/.bin/playwright" install --with-deps chromium
fi

chown -R root:root "${DOC_RUNTIME_DIR}"
chmod -R a+rX "${DOC_RUNTIME_DIR}"
printf '%s\n' "${PROFILE}" > "${DOC_RUNTIME_DIR}/.runtime-profile"
printf '%s\n' "${SPEC_SHA}" > "${STAMP_FILE}"
chmod 644 "${STAMP_FILE}"

echo "==> [doc-runtime] Ready at ${DOC_RUNTIME_DIR}."
