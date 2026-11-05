#!/usr/bin/env bash
# Sign only a committed root package. The existing private key is read only by openssl.
set -euo pipefail
repo="$(git rev-parse --show-toplevel)"
output="${1:?usage: sign-update.sh OUTPUT_DIR [COMMIT]}"
revision="${2:-HEAD}"
mkdir -p "$output"
key="$(python3 - "$repo/native/host-steward/host_steward/data/installer.toml" <<'PY'
import pathlib, sys, tomllib
print(pathlib.Path(tomllib.load(open(sys.argv[1], 'rb'))['signing_key']).expanduser())
PY
)"
git -C "$repo" archive --format=tar "$revision" native/host-steward > "$output/host-steward.tar"
openssl pkeyutl -sign -rawin -inkey "$key" -in "$output/host-steward.tar" -out "$output/host-steward.sig"
echo "Signed root update written to $output"
