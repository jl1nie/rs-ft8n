#!/bin/bash
# Deploy ft8-web/www/ → docs/ for GitHub Pages.
# Copies JS/HTML, rewrites the WASM import path, and injects the version
# from ft8-desktop/src-tauri/Cargo.toml (single source of truth).
set -euo pipefail
cd "$(dirname "$0")"

# Ensure pre-commit hook is always active (self-healing: safe to run repeatedly)
git config core.hooksPath .githooks 2>/dev/null || true

SRC=ft8-web/www
DST=docs

# Extract version from Cargo.toml (single source of truth)
VERSION=$(grep '^version' ft8-desktop/src-tauri/Cargo.toml | head -1 | sed 's/version = "\(.*\)"/\1/')

# Copy all JS and HTML (skip WASM binary — built separately)
for f in "$SRC"/*.js "$SRC"/*.html "$SRC"/*.json; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  cp "$f" "$DST/$base"
done

# Rewrite WASM import path: ../pkg/ft8_web.js → ./ft8_web.js (all JS files)
sed -i "s|from '../pkg/ft8_web.js'|from './ft8_web.js'|g" "$DST/app.js"
sed -i "s|from '../pkg/ft8_web.js'|from './ft8_web.js'|g" "$DST/decode-worker.js"

# Inject version from Cargo.toml into docs/app.js
sed -i "s|APP_VERSION = '__VERSION__'|APP_VERSION = '$VERSION'|" "$DST/app.js"

# Bump service worker cache name so Tauri WebView2 discards stale cache
sed -i "s|CACHE_NAME = 'webft8-[^']*'|CACHE_NAME = 'webft8-v$VERSION'|" "$DST/sw.js"

echo "Deployed to docs/ (v$VERSION)"
