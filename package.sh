#!/usr/bin/env sh
# SPDX-FileCopyrightText: The pasejo Authors
# SPDX-License-Identifier: 0BSD

# Build ready-to-load extension directories under dist/. Each output
# folder is a copy of src/ with the matching manifest.json at its root,
# which is what `web-ext run` / `chrome --load-extension` expect. After
# the unpacked dirs are written, also zip each into an archive ready for
# AMO / Chrome Web Store submission:
#   * dist/pasejo-firefox.xpi   — AMO accepts .xpi (zip with that suffix)
#   * dist/pasejo-chromium.zip  — Chrome Web Store accepts plain .zip
# In both cases the archive root is the manifest.json, not the parent
# directory — that's what the stores require.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${ROOT}/dist"

build() {
  target="$1"
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
}

archive() {
  target="$1"
  suffix="$2"
  out="${DIST}/${target}"
  archive_path="${DIST}/pasejo-${target}.${suffix}"
  rm -f "${archive_path}"
  # cd into the unpacked dir so the archive root is manifest.json (not
  # `<target>/manifest.json`); -X strips extra OS metadata so two runs
  # on the same source produce byte-identical archives where possible.
  (cd "${out}" && zip -qrX "${archive_path}" .)
  printf 'packaged %s\n' "${archive_path}"
}

for target in firefox chromium; do
  build "${target}"
done

archive firefox xpi
archive chromium zip
