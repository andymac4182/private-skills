# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# The digest is the multi-architecture manifest for the Node 24.20.0 image,
# matching .node-version and the CI Node runtime.
# Keep the version and digest together when updating the runtime baseline.
FROM node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e AS base

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/corepack
WORKDIR /app
RUN mkdir -p "$COREPACK_HOME" \
  && corepack enable \
  && corepack install --global pnpm@11.19.0

# Keep the full source tree in this stage.  The lockfile is authoritative and
# a frozen install is required for both the web build and the portable worker.
FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @private-skills/web build

# Nitro's Node preset emits a self-contained server under apps/web/.output.
# Workspace packages are copied alongside node_modules because Nitro may keep a
# workspace dependency external rather than bundling it into the server output.
FROM base AS runtime
ENV NODE_ENV=production \
    PSKILLS_ENVIRONMENT=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NITRO_HOST=0.0.0.0 \
    NITRO_PORT=3000
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/web ./apps/web
COPY --from=build /app/packages ./packages
# Named volumes inherit this ownership on first use, so the non-root runtime
# can write artifacts/state without a startup chown or a privileged init step.
RUN mkdir -p /var/lib/private-skills/artifacts /var/lib/private-skills/state /var/lib/private-skills/scan \
  && chown -R node:node /var/lib/private-skills
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --input-type=module -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
STOPSIGNAL SIGTERM
CMD ["node", "apps/web/.output/server/index.mjs"]

# The worker intentionally has its own image target and command.  It shares no
# Docker socket with the API or host; scanner isolation is supplied by a
# separately configured executor boundary (see compose.yaml and deployment/).
FROM runtime AS worker
COPY --from=build --chown=node:node /app/workers ./workers
ENV NODE_ENV=production
USER node
HEALTHCHECK NONE
# Invoke the installed runner directly.  `pnpm worker` performs a workspace
# dependency status check and writes a temporary file under /app, which is
# intentionally read-only in this hardened worker image.
CMD ["node", "/app/node_modules/tsx/dist/cli.mjs", "workers/runner/src/index.ts"]
