#!/usr/bin/env sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APPDIR=${APPDIR:-$HERE}
BUNDLED_LIB_DIR="$APPDIR/usr/lib/evernote/appimage-libs"

if [ -n "${LD_LIBRARY_PATH:-}" ]; then
  export LD_LIBRARY_PATH="$BUNDLED_LIB_DIR:$LD_LIBRARY_PATH"
else
  export LD_LIBRARY_PATH="$BUNDLED_LIB_DIR"
fi

exec "$APPDIR/usr/lib/evernote/evernote" "$@"
