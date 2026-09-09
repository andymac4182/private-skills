# Pinned scanner images

These images are the portable isolated execution baseline for the worker. The
worker mounts a validated bundle at `/input` read-only, mounts a private report
directory at `/output`, runs with `--network=none`, drops all capabilities, and
does not mount a Docker socket. `packages/scanners/src/executor.ts` owns those
runtime flags; these images only package trusted scanner binaries and their
licenses.

The scanner source and base-image pins are recorded in
[`scanner-metadata.json`](./scanner-metadata.json). The source revisions are
full immutable Git object IDs:

| image | scanner | source pin | command | base image |
| --- | --- | --- | --- | --- |
| `private-skills/cisco-skill-scanner:2.1.0` | Cisco Skill Scanner | release `2.1.0`, commit `e00b32f98d7721e687b0c748207e67da5157b50f` | `skill-scanner` | `python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254` |
| `private-skills/nvidia-skillspector:2.11.1` | NVIDIA SkillSpector | release `v2.11.1`, commit `704bc9544260c2f41222dc0f92982521709496ab` | `skillspector` | same Python base |
| `private-skills/skillsguard:1.1.1` | Teycir SkillsGuard | commit `7badb5157f8f9e4dd9ee2acb6e0129636e3147e3` | `skillsguard` | `node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a5e5` |

The Python requirements are hash-locked in each image directory. Cisco's lock
comes from the exact PyPI release. SkillSpector is not published on PyPI, so
its runtime lock is exported from the pinned repository's `uv.lock`; the
Dockerfile installs the checked-out source with `--no-deps` after installing
that lock.

## Reproducible build and acceptance run

Use the acceptance script to fetch each exact source revision, verify the
resolved commit, stage a temporary Docker build context, build one image at a
time, and run the three real scanners against benign and inert malicious
`SKILL.md` fixtures. Docker context selection is explicit and does not change
the user's default Docker context:

```sh
DOCKER_CONTEXT=desktop-linux ./scripts/scanner-acceptance.sh all
```

The `build` subcommand only builds images. The `container` subcommand runs the
already-built images through the repository adapters and `DockerExecutor`.
`native` is available for development hosts without Docker and still invokes
the fetched scanner binaries directly; it never substitutes parser fixtures
for engine execution.

The Dockerfiles intentionally do not fetch a Git branch during `docker build`.
The script supplies a source tree fetched at the full revision from
`scanner-metadata.json`, and the lock files prevent dependency drift. SkillsGuard
is built from that source tree because it is not published on npm. Runtime
scanner arguments are fixed by the adapters, and the image entrypoints reject
unexpected executable names.
