# syntax=docker/dockerfile:1.7
FROM docker.io/library/python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

LABEL org.opencontainers.image.title="Private Skills Cisco Skill Scanner" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="2.1.0" \
      io.private-skills.scanner.id="cisco-skill-scanner" \
      io.private-skills.scanner.source-ref="2.1.0" \
      io.private-skills.scanner.source-revision="a24df340ca6056a6446a239f4a7b114b11c6073a"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp/empty-home

RUN groupadd --system --gid 65532 scanner \
 && useradd --system --uid 65532 --gid 65532 --home-dir /tmp/empty-home --create-home scanner \
 && mkdir -p /input /output /tmp/empty-home \
 && chown -R 65532:65532 /input /output /tmp/empty-home

# The exact wheel version is part of the image identity. Dependency hashes are
# resolved by the image lock/release pipeline before this Dockerfile is built.
COPY requirements.txt /tmp/requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes --requirement /tmp/requirements.txt \
 && rm -rf /root/.cache /tmp/requirements.txt

COPY entrypoint.sh /usr/local/bin/private-skills-scanner
RUN chmod 0555 /usr/local/bin/private-skills-scanner

USER 65532:65532
WORKDIR /input
ENTRYPOINT ["/usr/local/bin/private-skills-scanner"]
