#!/usr/bin/env sh
set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
APPDIR=${APPDIR:-$HERE}
BUNDLED_LIB_DIR="$APPDIR/usr/lib/evernote/appimage-libs"
SPLASH_PID=
SPLASH_WATCHER_PID=
EVERNOTE_PID=

if [ -n "${LD_LIBRARY_PATH:-}" ]; then
  export LD_LIBRARY_PATH="$BUNDLED_LIB_DIR:$LD_LIBRARY_PATH"
else
  export LD_LIBRARY_PATH="$BUNDLED_LIB_DIR"
fi

start_splash() {
  if [ "${EVERNOTE_SPLASH:-1}" = "0" ] || [ -z "${DISPLAY:-}" ]; then
    return
  fi
  if ! command -v wish >/dev/null 2>&1; then
    return
  fi

  splash_script="$APPDIR/usr/lib/evernote/appimage-splash.tcl"
  splash_image="$APPDIR/usr/lib/evernote/appimage-splash-logo.png"
  if [ ! -x "$splash_script" ]; then
    return
  fi
  if [ ! -f "$splash_image" ]; then
    splash_image="$APPDIR/evernote.png"
  fi
  if [ ! -f "$splash_image" ]; then
    return
  fi

  "$splash_script" "$splash_image" >/dev/null 2>&1 &
  SPLASH_PID=$!
}

stop_splash() {
  if [ -n "$SPLASH_WATCHER_PID" ]; then
    kill "$SPLASH_WATCHER_PID" 2>/dev/null || true
  fi
  if [ -n "$SPLASH_PID" ]; then
    kill "$SPLASH_PID" 2>/dev/null || true
  fi
}

watch_splash() {
  if command -v wmctrl >/dev/null 2>&1; then
    i=0
    while kill -0 "$EVERNOTE_PID" 2>/dev/null && [ "$i" -lt 120 ]; do
      if wmctrl -lx 2>/dev/null | awk '{print tolower($3)}' | grep -E '(^|\.)evernote(\.|$)' >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
      i=$((i + 1))
    done
  else
    sleep 4
  fi

  stop_splash
}

on_signal() {
  stop_splash
  if [ -n "$EVERNOTE_PID" ]; then
    kill "$EVERNOTE_PID" 2>/dev/null || true
  fi
}

start_splash
"$APPDIR/usr/lib/evernote/evernote" "$@" &
EVERNOTE_PID=$!
trap on_signal INT TERM HUP

if [ -n "$SPLASH_PID" ]; then
  watch_splash &
  SPLASH_WATCHER_PID=$!
fi

wait "$EVERNOTE_PID"
status=$?
stop_splash
exit "$status"
