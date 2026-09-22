# -----------------------------------------------------------------------------
# Philips Hue integration image.
#
# Gladys sandbox constraints ("the sandbox is the defense"):
#   - rootfs mounted READ-ONLY -> never write outside /data
#   - a single writable volume: /data (used for the paired-bridge credentials)
#   - runs as a non-root user
#   - multi-arch image (linux/amd64 + linux/arm64), see the CI workflow
# -----------------------------------------------------------------------------

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# dumb-init: forwards signals (SIGTERM) correctly for a graceful shutdown.
RUN apk add --no-cache dumb-init

WORKDIR /app

# Install PROD dependencies first (better build cache).
# `npm ci` only: it fails loudly when the lockfile is out of sync, which is what
# we want for a reproducible image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# The package managers only serve the install above: drop them from the runtime
# image. Less attack surface, and their own bundled dependencies (npm's tar,
# brace-expansion, ...) no longer fail the Trivy scan of code that never runs.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Then the integration code.
COPY index.js ./
COPY src ./src
COPY gladys-assistant-integration.json ./

ENV NODE_ENV=production

# The only writable location at runtime (paired bridges are stored here).
# Created and owned by `node` BEFORE the VOLUME declaration: Docker copies the
# ownership of this directory when it populates an empty volume, otherwise it
# creates it as root:root and the unprivileged process cannot write its
# credentials. (A bind mount keeps the host permissions, so this is a floor,
# not a guarantee — the integration reports the failure instead of crashing.)
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

# Run as an unprivileged user (already present in the node image).
USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "index.js"]
