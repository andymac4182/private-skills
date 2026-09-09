# syntax=docker/dockerfile:1.7
FROM docker.io/library/python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254

LABEL org.opencontainers.image.title="Private Skills NVIDIA SkillSpector" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="2.11.1" \
      io.private-skills.scanner.id="nvidia-skillspector" \
      io.private-skills.scanner.source-ref="v2.11.1" \
      io.private-skills.scanner.source-revision="704bc9544260c2f41222dc0f92982521709496ab"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HOME=/tmp/empty-home

RUN groupadd --system --gid 65532 scanner \
 && useradd --system --uid 65532 --gid 65532 --home-dir /tmp/empty-home --create-home scanner \
 && mkdir -p /input /output /tmp/empty-home \
 && chown -R 65532:65532 /input /output /tmp/empty-home

COPY requirements.txt /tmp/requirements.txt
COPY source/ /tmp/skillspector/
RUN python -m pip install --no-cache-dir --require-hashes --requirement /tmp/requirements.txt \
 && python -m pip install --no-cache-dir --no-deps --no-build-isolation /tmp/skillspector \
 && rm -rf /root/.cache /tmp/requirements.txt /tmp/skillspector

COPY entrypoint.sh /usr/local/bin/private-skills-scanner
RUN chmod 0555 /usr/local/bin/private-skills-scanner

USER 65532:65532
WORKDIR /input
ENTRYPOINT ["/usr/local/bin/private-skills-scanner"]
