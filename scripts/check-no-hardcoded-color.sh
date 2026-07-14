#!/usr/bin/env bash
# Fails if styles.css contains a hardcoded color (hex or hardcoded rgb channels).
# The only allowed color literal is an opacity on a variable's -rgb companion,
# e.g. rgba(var(--color-cyan-rgb), 0.15).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
hits="$(grep -nE '#[0-9a-fA-F]{6}|rgba\((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),\s*(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]),' "$root/styles.css" || true)"
if [ -n "$hits" ]; then
  echo "Hardcoded color in styles.css (design-system rule 2 violation):"
  echo "$hits"
  exit 1
fi
echo "styles.css: no hardcoded color — OK"
