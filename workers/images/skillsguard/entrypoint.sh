#!/bin/sh
set -eu

# DockerExecutor supplies the scanner executable as argv[0] after the image
# name. Consume that fixed name so the wrapper remains compatible with both
# DockerExecutor and direct image smoke tests.
if [ "$#" -gt 0 ] && [ "$1" = "skillsguard" ]; then
  shift
fi
if [ "$#" -lt 1 ]; then
  echo "scanner image requires a SkillsGuard target path" >&2
  exit 64
fi
exec /usr/local/bin/skillsguard "$@"
