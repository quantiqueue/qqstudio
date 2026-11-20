#!/bin/sh
# qqstudio installer for macOS and Linux.
#
#   curl -fsSL https://github.com/quantiqueue/qqstudio/releases/latest/download/install.sh | sh
#
# Installs to ~/.local/share/qqstudio (no sudo, nothing system-wide):
#   app/    qqstudio itself (from the latest GitHub release; replaced on every run)
#   node/   a private Node.js - only if this computer has no Node.js 18+
# the command ~/.local/bin/qqstudio, and a menu entry that opens qqstudio in its own window
# (Linux: ~/.local/share/applications/qqstudio.desktop; macOS: ~/Applications/qqstudio.app).
# Your settings, sessions, engines and models stay in ~/.qqstudio (never touched by an update).
# Run the same line again to update. Uninstall: qqstudio --uninstall
#
# Options (environment variables, e.g. `curl ... | QQSTUDIO_VERSION=v0.1.1 sh`):
#   QQSTUDIO_VERSION=v0.1.1   install a specific release instead of the latest
#   QQSTUDIO_TARBALL=path     install from a local qqstudio.tar.gz (testing)
#   QQSTUDIO_PRIVATE_NODE=1   always use a private Node.js, even if this computer has one
#   QQSTUDIO_NO_MENU=1        no menu entry / app
set -eu

REPO="${QQSTUDIO_REPO:-quantiqueue/qqstudio}"
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/qqstudio"
BIN_DIR="$HOME/.local/bin"
MIN_NODE=18
PORT=8003

say()  { printf '  %s\n' "$*"; }
step() { printf '\033[36m> %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL "$1" -o "$2"; }; fetch_out() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then fetch() { wget -qO "$2" "$1"; }; fetch_out() { wget -qO- "$1"; }
else die "curl or wget is needed"; fi
command -v tar >/dev/null 2>&1 || die "tar is needed"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

printf '\n\033[36mqqstudio installer\033[0m\n\n'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- 1. download qqstudio ---
step "Downloading qqstudio"
if [ -n "${QQSTUDIO_TARBALL:-}" ]; then
  cp "$QQSTUDIO_TARBALL" "$TMP/app.tar.gz"; say "from $QQSTUDIO_TARBALL"
else
  if [ -n "${QQSTUDIO_VERSION:-}" ]; then URL="https://github.com/$REPO/releases/download/$QQSTUDIO_VERSION/qqstudio.tar.gz"
  else URL="https://github.com/$REPO/releases/latest/download/qqstudio.tar.gz"; fi
  say "$URL"
  fetch "$URL" "$TMP/app.tar.gz" || die "download failed"
fi
mkdir -p "$TMP/app"
tar -xzf "$TMP/app.tar.gz" -C "$TMP/app"
[ -f "$TMP/app/bin/qqstudio.js" ] || die "the download doesn't look like qqstudio"

# --- stop a running qqstudio from this install ---
# Politely first (MCP servers and background commands stop with it; a loaded model keeps running and is picked up
# again), then SIGTERM to any copy still running from the app folder (it cleans up the same way).
STOPPED=0
if command -v curl >/dev/null 2>&1; then
  PING="$(curl -fsS -m 2 "http://127.0.0.1:$PORT/api/ping" 2>/dev/null || true)"
  case "$PING" in
    *'"app":"qqstudio"'*'"dir":"'"$ROOT/app"'"'*)
      curl -fsS -m 5 -X POST -H 'X-QQStudio: stop' "http://127.0.0.1:$PORT/api/stop" >/dev/null 2>&1 && { STOPPED=1; sleep 1; } ;;
  esac
fi
if command -v pkill >/dev/null 2>&1 && pkill -f "^[^ ]*node[^ ]* $ROOT/app/bin/qqstudio.js" 2>/dev/null; then STOPPED=1; sleep 1; fi
[ "$STOPPED" = 1 ] && say "Stopped the running qqstudio."

mkdir -p "$ROOT"
rm -rf "$ROOT/app"
mv "$TMP/app" "$ROOT/app"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/app/package.json" | head -n 1)"
say "Installed version $VERSION to $ROOT/app"

# --- 2. Node.js ---
step "Checking Node.js"
NODE=""
if [ "${QQSTUDIO_PRIVATE_NODE:-}" = "1" ]; then say "Using a private Node.js (QQSTUDIO_PRIVATE_NODE=1)"
elif command -v node >/dev/null 2>&1; then
  V="$(node -v 2>/dev/null | sed 's/^v//')"
  if [ "${V%%.*}" -ge "$MIN_NODE" ] 2>/dev/null; then NODE="$(command -v node)"; say "Using your Node.js $V ($NODE)"
  else say "Your Node.js $V is too old (needs $MIN_NODE+), using a private copy instead"; fi
fi
if [ -z "$NODE" ]; then
  if [ -x "$ROOT/node/bin/node" ]; then
    NODE="$ROOT/node/bin/node"; say "Using the private Node.js $("$NODE" -v) in $ROOT/node"
  else
    case "$(uname -s)" in Darwin) OS=darwin ;; Linux) OS=linux ;; *) die "unsupported system $(uname -s)" ;; esac
    case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; arm64|aarch64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
    # the newest LTS: the first line of index.tab whose "lts" column isn't "-"
    NV="$(fetch_out https://nodejs.org/dist/index.tab | awk -F'\t' 'NR>1 && $10 != "-" { print $1; exit }')"
    [ -n "$NV" ] || die "could not find the current Node.js LTS version"
    FILE="node-$NV-$OS-$ARCH.tar.gz"
    say "Downloading Node.js $NV ($OS-$ARCH, about 55 MB)"
    fetch "https://nodejs.org/dist/$NV/$FILE" "$TMP/$FILE" || die "the Node.js download failed"
    WANT="$(fetch_out "https://nodejs.org/dist/$NV/SHASUMS256.txt" | awk -v f="$FILE" '$2 == f { print $1 }')"
    [ -n "$WANT" ] && [ "$WANT" = "$(sha256 "$TMP/$FILE")" ] || die "the Node.js download failed the checksum check - please try again"
    tar -xzf "$TMP/$FILE" -C "$TMP"
    rm -rf "$ROOT/node"; mkdir -p "$ROOT/node/bin"
    mv "$TMP/node-$NV-$OS-$ARCH/bin/node" "$ROOT/node/bin/node"
    NODE="$ROOT/node/bin/node"
    say "Saved to $ROOT/node (only qqstudio uses it)"
  fi
fi

# --- 3. the qqstudio command ---
step "Adding the qqstudio command"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/qqstudio" <<LAUNCHER
#!/bin/sh
# qqstudio launcher (made by install.sh). "qqstudio --help" for the options, "qqstudio --uninstall" to remove it.
ROOT="$ROOT"
if [ "\${1:-}" = "--uninstall" ]; then exec sh "\$ROOT/app/install/uninstall.sh"; fi
NODE="\$ROOT/node/bin/node"
[ -x "\$NODE" ] || NODE="\$(command -v node || true)"
[ -n "\$NODE" ] || { echo "Node.js was not found. Run the qqstudio installer again to get a private copy." >&2; exit 1; }
export QQSTUDIO_LAUNCHER="$BIN_DIR/qqstudio"
exec "\$NODE" "\$ROOT/app/bin/qqstudio.js" "\$@"
LAUNCHER
chmod +x "$BIN_DIR/qqstudio"
say "$BIN_DIR/qqstudio"
case ":$PATH:" in
  *":$BIN_DIR:"*) ON_PATH=1 ;;
  *) ON_PATH=0; say "Note: $BIN_DIR is not on your PATH. Add this line to your ~/.zshrc or ~/.bashrc:"
     say "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
esac

# --- 4. menu entry: qqstudio in its own window (qqstudio --app) ---
if [ "${QQSTUDIO_NO_MENU:-}" != "1" ]; then
  if [ "$(uname -s)" = "Darwin" ]; then
    step "Adding qqstudio to your Applications folder"
    APP="$HOME/Applications/qqstudio.app"
    rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
    cat > "$APP/Contents/MacOS/qqstudio" <<MACAPP
#!/bin/sh
exec "$BIN_DIR/qqstudio" --app
MACAPP
    chmod +x "$APP/Contents/MacOS/qqstudio"
    [ -f "$ROOT/app/public/qqstudio.icns" ] && cp "$ROOT/app/public/qqstudio.icns" "$APP/Contents/Resources/qqstudio.icns"
    cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>qqstudio</string>
  <key>CFBundleIdentifier</key><string>io.quantiqueue.qqstudio</string>
  <key>CFBundleExecutable</key><string>qqstudio</string>
  <key>CFBundleIconFile</key><string>qqstudio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
    say "$APP"
  else
    step "Adding qqstudio to your applications menu"
    APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$APPS"
    cat > "$APPS/qqstudio.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=qqstudio
Comment=Local AI studio for llama.cpp and Strata
Exec="$BIN_DIR/qqstudio" --app
Icon=$ROOT/app/public/icon-512.png
Terminal=false
Categories=Development;Utility;
DESKTOP
    say "$APPS/qqstudio.desktop"
  fi
fi

CMD=qqstudio; [ "$ON_PATH" = 1 ] || CMD="$BIN_DIR/qqstudio"
printf '\n\033[32mqqstudio %s is installed.\033[0m\n' "$VERSION"
say "Start it:   $CMD --app     (its own window; or from your applications menu)"
say "            $CMD           (in this terminal, Ctrl+C to stop)"
say "Stop it:    $CMD --stop"
say "Options:    $CMD --help"
say "Uninstall:  $CMD --uninstall"
printf '\n'
