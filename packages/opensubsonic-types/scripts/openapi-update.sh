#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PKG_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
OUT_FILE="$PKG_DIR/openapi/openapi.json"
URL=${OPENAPI_URL:-https://opensubsonic.netlify.app/docs/openapi/openapi.json}

mkdir -p "$(dirname "$OUT_FILE")"

if [[ -n "${OPENAPI_SOCKS5:-}" ]]; then
  curl --socks5 "$OPENAPI_SOCKS5" --connect-timeout 10 --max-time 60 -fsSL "$URL" -o "$OUT_FILE"
elif [[ -n "${OPENAPI_PROXY:-}" ]]; then
  curl --proxy "$OPENAPI_PROXY" --connect-timeout 10 --max-time 60 -fsSL "$URL" -o "$OUT_FILE"
else
  curl --connect-timeout 10 --max-time 60 -fsSL "$URL" -o "$OUT_FILE"
fi

echo "Wrote OpenAPI spec to $OUT_FILE"
