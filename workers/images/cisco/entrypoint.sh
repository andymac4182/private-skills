#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$1" != "skill-scanner" ]; then
  echo "scanner image accepts only the pinned skill-scanner command" >&2
  exit 64
fi
exec "$@"
