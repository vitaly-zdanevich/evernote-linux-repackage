#!/usr/bin/env sh
set -eu

unset NODE_OPTIONS ELECTRON_RUN_AS_NODE

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  CONFIG_HOME=$XDG_CONFIG_HOME
elif [ -n "${HOME:-}" ]; then
  CONFIG_HOME=$HOME/.config
else
  CONFIG_HOME=
fi

if [ -n "$CONFIG_HOME" ]; then
  EVERNOTE_CONFIG_DIR="$CONFIG_HOME/Evernote"
  mkdir -p "$EVERNOTE_CONFIG_DIR" 2>/dev/null || true
  if [ -d "$EVERNOTE_CONFIG_DIR" ] && [ ! -f "$EVERNOTE_CONFIG_DIR/localsettings.json" ]; then
    printf '{}\n' > "$EVERNOTE_CONFIG_DIR/localsettings.json" 2>/dev/null || true
  fi
fi

EXTRA_FLAGS=${EVERNOTE_EXTRA_FLAGS:-}
SANDBOX_FLAGS=

if [ "${EVERNOTE_DISABLE_GPU:-0}" = "1" ]; then
  export LIBGL_ALWAYS_SOFTWARE=1
fi

if [ "${EVERNOTE_NO_SANDBOX:-auto}" = "1" ]; then
  export ELECTRON_DISABLE_SANDBOX=1
  SANDBOX_FLAGS="--no-sandbox"
elif [ "${EVERNOTE_NO_SANDBOX:-auto}" != "0" ] && [ ! -u "$HERE/chrome-sandbox" ]; then
  export ELECTRON_DISABLE_SANDBOX=1
  SANDBOX_FLAGS="--no-sandbox"
fi

# Intentionally allow EXTRA_FLAGS word splitting for Chromium flags.
exec "$HERE/Evernote" ${SANDBOX_FLAGS} ${EXTRA_FLAGS} "$@"
