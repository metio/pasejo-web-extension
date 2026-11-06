#!/bin/sh
# SPDX-FileCopyrightText: The pasejo Authors
# SPDX-License-Identifier: 0BSD

# Writes the pasejo configuration and stores the e2e suite reads into
# DIR and prints the configuration's path. The age key is the fixed
# test key from the Rust suite's `tests/common/mod.rs`; it carries no
# passphrase, so the browser-spawned host decrypts without a prompt.
#
# Usage: PASEJO_BIN=/path/to/pasejo e2e/bootstrap-store.sh DIR

set -eu

dir="$1"
mkdir -p "${dir}"
export PASEJO_CONFIG="${dir}/config.toml"
pasejo="${PASEJO_BIN}"
identity="${dir}/identity"
public_key='age1fdalwkzzv0vztxm08gmh6geddk095x0ww9ztfjdtlf673ynwugqssxx8qd'

printf '%s\n' \
  "# public key: ${public_key}" \
  'AGE-SECRET-KEY-14LGKWZMHDDWMLCL5EUU2FSQNEX33DZYR3F8VEPZSA670QRC3DA3SNSD535' \
  > "${identity}"
chmod 600 "${identity}"

"${pasejo}" store add --path "${dir}/store" --name test --default
"${pasejo}" store add --path "${dir}/slow-store" --name slow
"${pasejo}" identity add --global --file "${identity}"
"${pasejo}" recipient add --store test --public-key "${public_key}"
"${pasejo}" recipient add --store slow --public-key "${public_key}"

# `test` store: a login with a TOTP entry, a secret kept out of the
# browser, and one that asks before every fill.
printf '%s\n' 'hunter2' 'url: https://example.com' 'login: alice@example.com' \
  | "${pasejo}" secret add --store test alice
"${pasejo}" otp add --store test --secret JBSWY3DPEHPK3PXP alice
printf '%s\n' 'never-filled' 'url: https://example.com' 'login: carol@example.com' \
  'pasejo-fill: never' \
  | "${pasejo}" secret add --store test carol
printf '%s\n' 'confirm-me' 'url: https://confirm.test' 'login: dave@confirm.test' \
  'pasejo-confirm: always' \
  | "${pasejo}" secret add --store test dave

# `slow` store: its pull hook delays a decryption by two seconds, standing
# in for an identity that waits for a security-key touch. The fixture runs
# the host with hook throttling off, so every decryption waits.
printf '%s\n' 'slow-secret' 'url: https://slow.test' 'login: erin@slow.test' \
  | "${pasejo}" secret add --store slow erin
"${pasejo}" hook set --store slow --pull 'sleep 2'

# Fails the bootstrap early when the store does not answer as the suite
# expects.
"${pasejo}" browser query --store test example.com > /dev/null

echo "${PASEJO_CONFIG}"
