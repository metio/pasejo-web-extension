#!/usr/bin/env sh
# SPDX-FileCopyrightText: The pasejo Authors
# SPDX-License-Identifier: 0BSD

# Build ready-to-load extension directories under dist/. Each output
# folder is a copy of src/ with the matching manifest.json at its root,
# which is what `web-ext run` / `chrome --load-extension` expect.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${ROOT}/dist"

for target in firefox chromium; do
  out="${DIST}/${target}"
  rm -rf "${out}"
  mkdir -p "${out}" "${out}/icons"
  cp -R "${ROOT}/src/." "${out}/"
  cp "${ROOT}/manifests/${target}.json" "${out}/manifest.json"
  # Only ship the rendered PNGs the manifests reference. The SVG source
  # and the make-icons.sh helper are kept out of the extension bundle.
  for png in "${ROOT}/icons"/*.png; do
    [ -f "${png}" ] && cp "${png}" "${out}/icons/"
  done
  printf 'built %s\n' "${out}"
done
