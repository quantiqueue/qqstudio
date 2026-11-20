#!/bin/sh
# qqstudio uninstaller for macOS and Linux (run with: qqstudio --uninstall).
# Ejects the loaded model and stops qqstudio, then removes ~/.local/share/qqstudio, the qqstudio command and the
# menu entry. Your data in ~/.qqstudio is kept unless you say otherwise; it asks separately about
#   - downloaded engines and models (often tens of GB), and
#   - settings, workspaces and sessions.
# QQSTUDIO_DELETE_DATA=none / engines / all answers both questions without asking (testing).
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/qqstudio"
BIN="$HOME/.local/bin/qqstudio"
DATA="${QQSTUDIO_HOME:-$HOME/.qqstudio}"
PORT=8003

printf '\n\033[36mUninstalling qqstudio\033[0m\n'

# eject the loaded model and stop qqstudio (this install only, not a copy run from a clone)
if command -v curl >/dev/null 2>&1; then
  PING="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)"
  case "$PING" in
    *'"app":"qqstudio"'*'"dir":"'"$ROOT/app"'"'*)
      R="$(curl -fsS -m 60 -X POST -H 'X-QQStudio: stop' "http://127.0.0.1:$PORT/api/stop?eject=1" 2>/dev/null || true)"
      case "$R" in *'"ejected":"'*) echo "  Ejected $(printf '%s' "$R" | sed 's/.*"ejected":"\([^"]*\)".*/\1/')" ;; esac
      [ -n "$R" ] && { echo "  Stopped qqstudio"; sleep 1; } ;;
  esac
fi
command -v pkill >/dev/null 2>&1 && pkill -f "^[^ ]*node[^ ]* $ROOT/app/bin/qqstudio.js" 2>/dev/null && sleep 1

APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications/qqstudio.desktop"
[ -f "$APPS" ] && rm -f "$APPS" && echo "  Removed the menu entry"
[ -d "$HOME/Applications/qqstudio.app" ] && rm -rf "$HOME/Applications/qqstudio.app" && echo "  Removed ~/Applications/qqstudio.app"
[ -f "$BIN" ] && rm -f "$BIN" && echo "  Removed $BIN"
[ -d "$ROOT" ] && rm -rf "$ROOT" && echo "  Removed $ROOT"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/qqstudio"; [ -d "$CACHE" ] && rm -rf "$CACHE"
[ -d "$HOME/Library/Caches/qqstudio" ] && rm -rf "$HOME/Library/Caches/qqstudio"

ask() {
  printf '  %s [y/N] ' "$1"
  { read -r a </dev/tty; } 2>/dev/null || a=""
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

if [ -d "$DATA" ]; then
  DEL_BIG=0; DEL_REST=0
  case "${QQSTUDIO_DELETE_DATA:-}" in
    none) ;;
    engines) DEL_BIG=1 ;;
    all) DEL_BIG=1; DEL_REST=1 ;;
    *)
      if [ -d "$DATA/engines" ] || [ -d "$DATA/models" ]; then
        SIZE="$(du -sh "$DATA/engines" "$DATA/models" 2>/dev/null | awk '{ printf "%s%s", (NR>1 ? " + " : ""), $1 }')"
        ask "Delete the downloaded engines and models in $DATA ($SIZE)?" && DEL_BIG=1
      fi
      ask "Delete your settings, workspaces and sessions in $DATA?" && DEL_REST=1 ;;
  esac
  if [ "$DEL_BIG" = 1 ] && [ "$DEL_REST" = 1 ]; then rm -rf "$DATA"; echo "  Deleted $DATA"
  else
    [ "$DEL_BIG" = 1 ] && { rm -rf "$DATA/engines" "$DATA/models"; echo "  Deleted the engines and models"; }
    if [ "$DEL_REST" = 1 ]; then
      for f in "$DATA"/* "$DATA"/.[!.]*; do
        [ -e "$f" ] || continue
        case "$(basename "$f")" in engines|models) ;; *) rm -rf "$f" ;; esac
      done
      echo "  Deleted the settings, workspaces and sessions"
    fi
    [ "$DEL_BIG" = 0 ] && [ "$DEL_REST" = 0 ] && echo "  Kept $DATA (installing again picks it up)"
  fi
fi
printf '\n\033[32mqqstudio has been uninstalled.\033[0m\n\n'
