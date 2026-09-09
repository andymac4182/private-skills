# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

LABEL org.opencontainers.image.title="Private Skills SkillsGuard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="1.1.1" \
      io.private-skills.scanner.id="skillsguard" \
      io.private-skills.scanner.source-kind="source-build" \
      io.private-skills.scanner.source-ref="main" \
      io.private-skills.scanner.source-revision="7badb5157f8f9e4dd9ee2acb6e0129636e3147e3"

ENV HOME=/tmp/empty-home \
    NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

RUN groupadd --system --gid 65532 scanner \
 && useradd --system --uid 65532 --gid 65532 --home-dir /tmp/empty-home --create-home scanner \
 && mkdir -p /input /output /tmp/empty-home /opt/skillsguard \
 && chown -R 65532:65532 /input /output /tmp/empty-home /opt/skillsguard

# Trusted build input: workers/images/skillsguard/source is a source tree
# obtained from main and verified at commit
# 7badb5157f8f9e4dd9ee2acb6e0129636e3147e3. This is a source build; the
# v1.1.1 tag points at a different upstream commit. SkillsGuard is not
# published on npm.
COPY source/ /opt/skillsguard/
WORKDIR /opt/skillsguard
RUN npm ci --include=dev --ignore-scripts \
 && npm run build \
 && npm prune --omit=dev --ignore-scripts \
 && rm -rf /root/.npm /opt/skillsguard/src /opt/skillsguard/test* /opt/skillsguard/.git

RUN ln -s /opt/skillsguard/dist/cli.js /usr/local/bin/skillsguard \
 && chmod 0555 /usr/local/bin/skillsguard

COPY entrypoint.sh /usr/local/bin/private-skills-scanner
RUN chmod 0555 /usr/local/bin/private-skills-scanner

USER 65532:65532
WORKDIR /input
ENTRYPOINT ["/usr/local/bin/private-skills-scanner"]
