#!/usr/bin/env bash
# Rebuilds web/static/vendor/tiptap.js.
#
# The bundle is committed so the app itself needs no node, no npm and no build
# step: it is a static file served next to the rest of the front end. This
# script exists so that file is reproducible rather than mysterious.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../web/static/vendor/tiptap.js"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cp "$here/editor-bundle.entry.js" "$work/entry.js"
cd "$work"
printf '{ "name": "tp-editor-bundle", "private": true, "type": "module" }\n' > package.json

npm install --no-audit --no-fund --silent \
  @tiptap/core @tiptap/pm @tiptap/starter-kit \
  @tiptap/extension-table @tiptap/extension-table-row \
  @tiptap/extension-table-cell @tiptap/extension-table-header \
  @tiptap/extension-image @tiptap/extension-link esbuild

npx esbuild entry.js --bundle --format=iife --minify --target=es2020 --outfile=tiptap.js
cp tiptap.js "$out"
echo "wrote $out"
