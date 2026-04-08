#!/bin/bash
# Deploy ft8-web/www/ → docs/ for GitHub Pages.
# Copies JS/HTML and rewrites the WASM import path.
set -euo pipefail
cd "$(dirname "$0")"

SRC=ft8-web/www
DST=docs

# Copy all JS and HTML (skip WASM binary — built separately)
for f in "$SRC"/*.js "$SRC"/*.html "$SRC"/*.json; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  cp "$f" "$DST/$base"
done

# Rewrite WASM import path: ../pkg/ft8_web.js → ./ft8_web.js
sed -i "s|from '../pkg/ft8_web.js'|from './ft8_web.js'|g" "$DST/app.js"

echo "Deployed to docs/"
diff <(head -1 "$SRC/app.js") <(head -1 "$DST/app.js") || true
