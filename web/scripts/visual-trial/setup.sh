#!/usr/bin/env bash
# Local installation avoids root access and system package changes.
set -euo pipefail

CACHE_DIR="${SOE_TRIAL_BROWSER_DIR:-$HOME/.cache/soe-visual-trial}"
LEGACY_DIR=/tmp/opencode/m5-visual-tools
WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LIB_PACKAGES=(
  libasound2t64
  libatk-bridge2.0-0t64
  libatk1.0-0t64
  libatspi2.0-0t64
  libdbus-1-3
  libdrm2
  libdrm-common
  libgbm1
  libxcomposite1
  libxdamage1
  libxfixes3
  libxi6
  libxkbcommon0
  libxrandr2
)

if [ -d "$LEGACY_DIR/browsers" ] && [ ! -d "$CACHE_DIR/browsers" ]; then
  echo "Using $LEGACY_DIR; nothing to install."
  exit 0
fi

mkdir -p "$CACHE_DIR"
CACHE_DIR="$(realpath "$CACHE_DIR")"
mkdir -p "$CACHE_DIR/libs" "$CACHE_DIR/debs" "$CACHE_DIR/tmp"

if ! ls "$CACHE_DIR"/browsers/chromium_headless_shell-* > /dev/null 2>&1; then
  PLAYWRIGHT_BROWSERS_PATH="$CACHE_DIR/browsers" \
    TMPDIR="$CACHE_DIR/tmp" \
    node "$WEB_DIR/node_modules/playwright-core/cli.js" install chromium-headless-shell
fi

EXECUTABLE="$(find "$CACHE_DIR/browsers" -name chrome-headless-shell -type f | head -n 1)"
LIBS="$CACHE_DIR/libs/usr/lib/x86_64-linux-gnu"

if LD_LIBRARY_PATH="$LIBS" ldd "$EXECUTABLE" | grep -q "not found"; then
  # apt-get download needs no root; the packages are unpacked here instead of installed.
  (cd "$CACHE_DIR/debs" && apt-get download "${LIB_PACKAGES[@]}")
  for package in "$CACHE_DIR"/debs/*.deb; do
    dpkg -x "$package" "$CACHE_DIR/libs"
  done
fi

if LD_LIBRARY_PATH="$LIBS" ldd "$EXECUTABLE" | grep "not found"; then
  echo "Some libraries are still missing; see above." >&2
  exit 1
fi

echo "Chromium ready in $CACHE_DIR"
