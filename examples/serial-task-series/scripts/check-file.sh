#!/bin/sh
set -eu

file="${1:-}"
expected="${2:-}"

if [ -z "$file" ] || [ -z "$expected" ]; then
  echo "usage: check-file.sh <file> <expected-text>" >&2
  exit 2
fi

if [ ! -f "$file" ]; then
  echo "$file does not exist" >&2
  exit 1
fi

if ! grep -F "$expected" "$file" >/dev/null; then
  echo "$file does not contain $expected" >&2
  exit 1
fi
