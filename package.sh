#!/usr/bin/env sh
# SPDX-FileCopyrightText: The pasejo Authors
# SPDX-License-Identifier: 0BSD

# Usage: ./package.sh [VERSION]
#
# Builds the unpacked extensions under dist/firefox and dist/chromium, the
# store archives dist/pasejo-firefox.xpi and dist/pasejo-chromium.zip (with
# manifest.json at the archive root, as AMO and the Chrome Web Store
# require), and dist/SHA256SUMS over both archives. VERSION, when given,
# replaces the manifests' version in dist/ only.
#
# The archives are byte-reproducible: entries are sorted, every file is
# mode 0644 with the timestamp SOURCE_DATE_EPOCH (default 1980-01-01, the
# earliest a zip entry can carry), and zip stores no uid/gid or extended
# timestamps. Two builds of the same commit with the same zip program
# therefore produce the same SHA256SUMS.

set -eu

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="${ROOT}/dist"
VERSION="${1:-}"
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-315532800}"

export TZ=UTC LC_ALL=C
# zip reads default options from these variables.
unset ZIPOPT ZIP

if [ -n "${VERSION}" ] && ! printf '%s\n' "${VERSION}" | grep -Eqx '[0-9]+(\.[0-9]+){0,3}'; then
  printf 'package.sh: %s is not a manifest version (one to four dot-separated integers)\n' "${VERSION}" >&2
  exit 1
fi

STAMP="$(date -u -d "@${SOURCE_DATE_EPOCH}" +%Y%m%d%H%M.%S 2>/dev/null ||
  date -u -r "${SOURCE_DATE_EPOCH}" +%Y%m%d%H%M.%S)"

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

build() {
  target="$1"
  out="${DIST}/${target}"
  rm -rf "${out}"
  mkdir -p "${out}" "${out}/icons"
  cp -R "${ROOT}/src/." "${out}/"
  if [ -n "${VERSION}" ]; then
    sed "s/^  \"version\": \"[^\"]*\",\$/  \"version\": \"${VERSION}\",/" \
      "${ROOT}/manifests/${target}.json" >"${out}/manifest.json"
    grep -qx "  \"version\": \"${VERSION}\"," "${out}/manifest.json"
  else
    cp "${ROOT}/manifests/${target}.json" "${out}/manifest.json"
  fi
  # The SVG source and make-icons.sh stay out of the bundle.
  for png in "${ROOT}/icons"/*.png; do
    [ -f "${png}" ] && cp "${png}" "${out}/icons/"
  done
  find "${out}" -type d -exec chmod 0755 {} +
  find "${out}" -type f -exec chmod 0644 {} +
  find "${out}" -exec touch -t "${STAMP}" {} +
  printf 'built %s\n' "${out}"
}

archive() {
  target="$1"
  suffix="$2"
  name="pasejo-${target}.${suffix}"
  rm -f "${DIST}/${name}"
  (cd "${DIST}/${target}" && find . -type f | sed 's|^\./||' | sort | zip -qX -D -@ "${DIST}/${name}")
  printf 'packaged %s\n' "${DIST}/${name}"
}

for target in firefox chromium; do
  build "${target}"
done

archive firefox xpi
archive chromium zip

(cd "${DIST}" && sha256 pasejo-chromium.zip pasejo-firefox.xpi >SHA256SUMS)
printf 'wrote %s\n' "${DIST}/SHA256SUMS"
