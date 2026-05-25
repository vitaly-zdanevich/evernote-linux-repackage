#!/usr/bin/env bash
set -euo pipefail

appimage=${1:?usage: smoke-test-clean-container.sh <AppImage> <AppImage arch>}
appimage_arch=${2:-${APPIMAGE_ARCH:-}}
bundled_lib=usr/lib/evernote/appimage-libs/libsecret-1.so.0

if [[ ! -x "$appimage" ]]; then
  echo "AppImage is not executable: $appimage" >&2
  exit 1
fi

rm -rf squashfs-root
"$appimage" --appimage-extract "$bundled_lib" >/dev/null
test -f "squashfs-root/$bundled_lib"
rm -rf squashfs-root

if [[ "$appimage_arch" != "x86_64" ]]; then
  echo "Skipping clean-container runtime smoke for $appimage_arch."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for clean-container AppImage smoke testing." >&2
  exit 1
fi

docker run --rm \
  -e DEBIAN_FRONTEND=noninteractive \
  -e EVERNOTE_CONTAINER_APPIMAGE="/workspace/$appimage" \
  -v "$PWD:/workspace:ro" \
  -w /workspace \
  node:24-bookworm-slim \
  bash -euo pipefail -c '
    apt-get update
    apt-get install -y --no-install-recommends \
      ca-certificates \
      xvfb \
      xauth \
      libgtk-3-0 \
      libnss3 \
      libxss1 \
      libasound2 \
      libgbm1 \
      libatk-bridge2.0-0 \
      libx11-xcb1 \
      libdrm2 \
      libxcomposite1 \
      libxdamage1 \
      libxrandr2 \
      libxkbcommon0 \
      libxshmfence1

    if dpkg-query -W libsecret-1-0 >/dev/null 2>&1; then
      echo "Container unexpectedly has libsecret-1-0 installed." >&2
      exit 1
    fi

    APPIMAGE_EXTRACT_AND_RUN=1 \
      EVERNOTE_SMOKE_EXECUTABLE="$EVERNOTE_CONTAINER_APPIMAGE" \
      node scripts/smoke-test.js
  '
