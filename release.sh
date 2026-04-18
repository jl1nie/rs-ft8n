#!/bin/bash
# WebFT8 release script — one command to release both web and Tauri desktop.
#
# Usage:
#   1. Bump version in ft8-desktop/src-tauri/Cargo.toml
#   2. Stage and commit all source changes (git add / git commit)
#   3. ./release.sh
#
# What this script does:
#   - Sets core.hooksPath so pre-commit hook runs from now on
#   - Deploys ft8-web/www/ → docs/ (version injection, import rewrite)
#   - Commits the docs/ update if anything changed
#   - Builds Tauri desktop (.exe and .msi)
#   - Pushes to origin/main and creates a git tag
#   - Creates (or updates) a GitHub release with the installer assets
set -euo pipefail
cd "$(dirname "$0")"

# ── 0. Hook setup ──────────────────────────────────────────────────────────
git config core.hooksPath .githooks
echo "[release] core.hooksPath = .githooks"

# ── 1. Version from single source of truth ────────────────────────────────
VERSION=$(grep '^version' ft8-desktop/src-tauri/Cargo.toml | head -1 \
          | sed 's/version = "\(.*\)"/\1/')
echo "[release] WebFT8 v${VERSION}"

# ── 2. Deploy web assets → docs/ ──────────────────────────────────────────
bash deploy.sh
git add -f docs/*.js docs/*.html docs/*.json docs/*.md

if ! git diff --cached --quiet; then
  git commit -m "chore: deploy web assets for v${VERSION}

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
  echo "[release] Committed docs/ update"
else
  echo "[release] docs/ already up to date"
fi

# ── 3. Tauri desktop build ─────────────────────────────────────────────────
echo "[release] Building Tauri desktop..."
(cd ft8-desktop && cargo tauri build)

NSIS="ft8-desktop/src-tauri/target/release/bundle/nsis/WebFT8_${VERSION}_x64-setup.exe"
MSI="ft8-desktop/src-tauri/target/release/bundle/msi/WebFT8_${VERSION}_x64_en-US.msi"

# ── 4. Push commits and tag ────────────────────────────────────────────────
git push origin main
echo "[release] Pushed main"

if git tag "v${VERSION}" 2>/dev/null; then
  git push origin "v${VERSION}"
  echo "[release] Tagged and pushed v${VERSION}"
else
  echo "[release] Tag v${VERSION} already exists — skipping tag"
fi

# ── 5. GitHub release ─────────────────────────────────────────────────────
if gh release view "v${VERSION}" &>/dev/null; then
  echo "[release] Updating existing release v${VERSION}..."
  gh release delete-asset "v${VERSION}" "WebFT8_${VERSION}_x64-setup.exe" --yes 2>/dev/null || true
  gh release delete-asset "v${VERSION}" "WebFT8_${VERSION}_x64_en-US.msi"  --yes 2>/dev/null || true
  gh release upload "v${VERSION}" "$NSIS" "$MSI"
else
  echo "[release] Creating new release v${VERSION}..."
  gh release create "v${VERSION}" "$NSIS" "$MSI" \
    --title "WebFT8 v${VERSION}" \
    --generate-notes
fi

echo "[release] Done — https://github.com/jl1nie/webft8/releases/tag/v${VERSION}"
