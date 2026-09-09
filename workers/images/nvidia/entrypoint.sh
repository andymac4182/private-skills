#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$1" != "skillspector" ]; then
  echo "scanner image accepts only the pinned skillspector command" >&2
  exit 64
fi
exec "$@"
