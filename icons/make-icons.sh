#!/usr/bin/env sh
# SPDX-FileCopyrightText: The pasejo Authors
# SPDX-License-Identifier: 0BSD

# Render the master icons/pasejo.svg into the PNG sizes the WebExtensions
# manifest expects. Requires ImageMagick 7 (`magick`) or 6 (`convert`).

set -eu

DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="${DIR}/pasejo.svg"

if command -v magick >/dev/null 2>&1; then
  RENDER="magick -background none"
elif command -v convert >/dev/null 2>&1; then
  RENDER="convert -background none"
else
  echo "neither 'magick' nor 'convert' (ImageMagick) is on PATH" >&2
  exit 1
fi

# ImageMagick's preferred SVG path goes through rsvg-convert; on systems
# where that delegate is missing, the built-in MSVG parser handles the
# subset of SVG features the icon uses.
INPUT="MSVG:${SRC}"
if command -v rsvg-convert >/dev/null 2>&1; then
  INPUT="${SRC}"
fi

for size in 16 32 48 128; do
  out="${DIR}/pasejo-${size}.png"
  # shellcheck disable=SC2086
  ${RENDER} -density 384 "${INPUT}" -resize "${size}x${size}" "${out}"
  printf 'rendered %s\n' "${out}"
done
