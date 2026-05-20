#!/usr/bin/env bash
# Feynman — QA environment bootstrap.
# Double-click this in Finder to: build the plugin, sync the fresh build into
# the sandbox vault, check the local Docker server is reachable, and open the
# vault in Obsidian. Leave the Terminal window open.

set -euo pipefail

# Ensure system binaries are on PATH so npm can spawn `sh` for native
# postinstall scripts (esbuild). Finder-launched Terminal sessions can inherit
# a stripped PATH from launchd that omits /bin, which makes `npm install` fail
# with `spawn sh ENOENT` during postinstalls.
export PATH="/bin:/usr/bin:/usr/local/bin:/opt/homebrew/bin:${PATH:-}"

# Derive REPO from the script's own location so this works for any user on
# any machine. `BASH_SOURCE[0]` is the script path even when double-clicked
# from Finder. `pwd -P` resolves symlinks.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Vault defaults to ~/Documents/kanban-test-vault (shared with the kanban
# plugin's QA setup so both plugins exercise the same vault). Override with
# FEYNMAN_QA_VAULT=/some/path before running if your vault lives elsewhere.
VAULT="${FEYNMAN_QA_VAULT:-$HOME/Documents/kanban-test-vault}"
if [ ! -d "$VAULT" ]; then
  echo "✗ Vault not found at: $VAULT" >&2
  echo "  Create the vault in Obsidian first, or set FEYNMAN_QA_VAULT to its path." >&2
  exit 1
fi
PLUGIN_DIR="$VAULT/.obsidian/plugins/feynman"

# Container the plugin expects to talk to. Override FEYNMAN_QA_PORT if you've
# moved the host port off the default.
SERVER_HOST="${FEYNMAN_QA_HOST:-127.0.0.1}"
SERVER_PORT="${FEYNMAN_QA_PORT:-7777}"

cd "$REPO"
echo "=== Feynman QA bootstrap ==="
echo "Repo:    $REPO"
echo "Vault:   $VAULT"
echo "Server:  http://$SERVER_HOST:$SERVER_PORT"
echo ""

# --- 1. Build the plugin from source ---------------------------------------
# QA must always run against a fresh build. Skips `npm install` if
# node_modules looks present — first-time setup the user runs `npm install`
# themselves per docs/SETUP.md.
if [ ! -d node_modules ]; then
  echo "✗ node_modules missing. Run \`npm install\` once before this script." >&2
  echo "  See docs/SETUP.md step 3." >&2
  exit 1
fi
echo "→ building plugin from source (npm run build)"
npm run build
echo ""

# --- 2. Staleness guard ----------------------------------------------------
# Belt-and-braces in case the build silently fails to update main.js (esbuild
# cache, tsc-only warnings, partial bundle). Compare main.js mtime to the
# newest source file under src/ AND main.ts.
NEWEST_SRC=$( ( find src -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -print0 ;
                printf '%s\0' main.ts manifest.json styles.css ) \
  | xargs -0 stat -f '%m' 2>/dev/null | sort -n | tail -1 )
BUILD_MTIME=$(stat -f '%m' main.js 2>/dev/null || echo 0)
if [ "$BUILD_MTIME" -lt "$NEWEST_SRC" ]; then
  echo "✗ main.js ($BUILD_MTIME) is older than newest src/ file ($NEWEST_SRC)." >&2
  echo "  Refusing to deploy a stale build. Investigate the build step above." >&2
  exit 1
fi
echo "→ build freshness OK ($(wc -c < main.js) bytes)"
echo ""

# --- 3. Install / refresh the build in the vault ---------------------------
mkdir -p "$PLUGIN_DIR"
sync_build_file() {
  local src="$1" dst="$2"
  if [ -L "$dst" ]; then
    echo "   ✓ $(basename "$dst") is a symlink, skipping (already live-linked)"
  elif [ -e "$dst" ] && [ "$(stat -f %i "$src" 2>/dev/null)" = "$(stat -f %i "$dst" 2>/dev/null)" ]; then
    echo "   ✓ $(basename "$dst") is the same inode, skipping"
  else
    cp -f "$src" "$dst"
    echo "   → copied $(basename "$dst")"
  fi
}
echo "→ syncing main.js / manifest.json / styles.css into vault"
sync_build_file "$REPO/main.js"        "$PLUGIN_DIR/main.js"
sync_build_file "$REPO/manifest.json"  "$PLUGIN_DIR/manifest.json"
sync_build_file "$REPO/styles.css"     "$PLUGIN_DIR/styles.css"
echo "   main.js size in vault: $(wc -c < "$PLUGIN_DIR/main.js") bytes"
echo ""

# --- 4. Server reachability check ------------------------------------------
# The plugin needs @feynman/server running in Docker. We don't start it
# automatically — spawning Pi consumes Anthropic credits. Just probe and
# report.
echo "→ probing Feynman server at http://$SERVER_HOST:$SERVER_PORT/v1/health"
if curl -sf --max-time 2 "http://$SERVER_HOST:$SERVER_PORT/v1/health" > /tmp/feynman-health.json 2>/dev/null; then
  echo "   ✓ server is up: $(cat /tmp/feynman-health.json)"
  rm -f /tmp/feynman-health.json
else
  echo "   ⚠ server NOT reachable. Plugin will surface 'Feynman server not reachable'."
  echo "     Start it per docs/SETUP.md step 5, e.g.:"
  echo ""
  echo "       docker run -d --name feynman-server-test \\"
  echo "         -p 127.0.0.1:$SERVER_PORT:7777 \\"
  echo "         -v \"$VAULT:/vault\" \\"
  echo "         -e FEYNMAN_VAULT=/vault \\"
  echo "         -e ANTHROPIC_API_KEY=\"\$ANTHROPIC_API_KEY\" \\"
  echo "         feynman/server:dev"
  echo ""
fi
echo ""

# --- 5. Open the vault in Obsidian -----------------------------------------
# `obsidian://open` honors a vault by *name*. Easier and more reliable: use
# the `obsidian://` URL form with `path=<absolute path>` so Obsidian opens
# the exact directory we just synced into. Falls back to `open -a` if the
# URL handler is missing.
echo "→ opening vault in Obsidian"
VAULT_URL="obsidian://open?path=$(python3 -c 'import urllib.parse, sys; print(urllib.parse.quote(sys.argv[1]))' "$VAULT")"
if ! open "$VAULT_URL" 2>/dev/null; then
  open -a Obsidian "$VAULT" || {
    echo "   ⚠ couldn't auto-open Obsidian. Open it manually and switch to the test vault."
  }
fi
echo ""
echo "=== QA bootstrap done ==="
echo ""
echo "Next:"
echo "  • In Obsidian: Settings → Community plugins → make sure Feynman is enabled."
echo "  • Cmd-P → 'Feynman: Server status' should show ok=true."
echo "  • Follow docs/TESTING.md for the M0/M1/M2 verification steps."
echo ""
echo "Leave this window open while you test (no daemon runs here; closing is fine,"
echo "but keeping it lets you re-run the script with ↑ + ↵ after editing source)."
