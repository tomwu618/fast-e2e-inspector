#!/usr/bin/env bash
# Fast Build & Static Chunk Integrity Probe (check-chunks.sh)
# Detects missing, truncated, or out-of-sync JS/CSS chunks between Vite/Webpack dist and backend static dir
#
# Usage:
#   bash scripts/check-chunks.sh <frontend-dist-dir> <backend-static-dir> [base-url]

set -euo pipefail

DIST_DIR="${1:-./frontend/dist}"
STATIC_DIR="${2:-./build/resources/main/static}"
BASE_URL="${3:-}"

echo "=== [1/3] Checking index.html sync ==="
if [[ ! -f "$DIST_DIR/index.html" ]]; then
  echo "[ERROR] Missing $DIST_DIR/index.html"
  exit 1
fi
if [[ ! -f "$STATIC_DIR/index.html" ]]; then
  echo "[ERROR] Missing $STATIC_DIR/index.html"
  exit 1
fi

DIST_HASH=$(shasum -a 256 "$DIST_DIR/index.html" | awk '{print $1}')
STATIC_HASH=$(shasum -a 256 "$STATIC_DIR/index.html" | awk '{print $1}')
if [[ "$DIST_HASH" != "$STATIC_HASH" ]]; then
  echo "[FAIL] index.html mismatch between dist ($DIST_HASH) and static ($STATIC_HASH)"
  exit 1
else
  echo "[OK] index.html hashes match ($DIST_HASH)"
fi

echo "=== [2/3] Checking all JS/CSS chunks for existence and exact byte size ==="
MISSING_COUNT=0
MISMATCH_COUNT=0
TOTAL_COUNT=0

while IFS= read -r -d '' dist_file; do
  rel_path="${dist_file#$DIST_DIR/}"
  static_file="$STATIC_DIR/$rel_path"
  TOTAL_COUNT=$((TOTAL_COUNT + 1))

  if [[ ! -f "$static_file" ]]; then
    echo "[MISSING] $rel_path does not exist in $STATIC_DIR"
    MISSING_COUNT=$((MISSING_COUNT + 1))
    continue
  fi

  dist_size=$(wc -c < "$dist_file" | tr -d ' ')
  static_size=$(wc -c < "$static_file" | tr -d ' ')

  if [[ "$dist_size" != "$static_size" ]]; then
    echo "[TRUNCATED/MISMATCH] $rel_path: dist=${dist_size}B vs static=${static_size}B"
    MISMATCH_COUNT=$((MISMATCH_COUNT + 1))
  fi
done < <(find "$DIST_DIR/assets" -type f \( -name "*.js" -o -name "*.css" \) -print0)

echo "Checked $TOTAL_COUNT asset chunks: $MISSING_COUNT missing, $MISMATCH_COUNT size mismatches."
if [[ "$MISSING_COUNT" -gt 0 || "$MISMATCH_COUNT" -gt 0 ]]; then
  exit 1
fi

if [[ -n "$BASE_URL" ]]; then
  echo "=== [3/3] Probing HTTP 200 on largest chunks via $BASE_URL ==="
  TOP_CHUNKS=$(find "$DIST_DIR/assets" -type f -name "*.js" -exec ls -S {} + 2>/dev/null || true)
  sed -n "1,5p" <<< "$TOP_CHUNKS" | while read -r top_chunk; do
    rel="${top_chunk#$DIST_DIR/}"
    expected_size=$(wc -c < "$top_chunk" | tr -d ' ')
    http_code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/$rel")
    echo "  -> GET $BASE_URL/$rel : HTTP $http_code (expected ${expected_size}B)"
    if [[ "$http_code" != "200" ]]; then
      echo "[FAIL] Asset probe failed with HTTP $http_code"
      exit 1
    fi
  done
fi

echo "[PASS] All static chunks verified intact."
