# Two stages: `build` installs every dependency and compiles dist/ and the
# generated public/ files; the runtime stage starts again from the slim image
# with production dependencies and only what the server reads.
FROM node:22 AS build
WORKDIR /app

# The manifests and patches first, so the dependency layer is reused until
# they change. .npmrc: onnxruntime-node skips its CUDA download (the model
# runs on the CPU).
COPY package.json package-lock.json .npmrc ./
COPY patches/ patches/
RUN npm ci --no-audit --no-fund

COPY --link src/ src/
COPY --link views/ views/
COPY --link public/ public/
COPY --link scripts/ scripts/
COPY tsconfig.json tsconfig.build.json ./

# No .git in the build context, so public/build.json records only the build time; the release
# (APP_VERSION, below) is what names the build at runtime. Nothing commit-specific is in this
# stage, so its layers stay cached across commits.
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app

COPY package.json package-lock.json .npmrc ./
COPY patches/ patches/
# Runtime dependencies only. Everything the running app serves or loads from
# node_modules (htmx, workbox-window, sharp, onnxruntime-node) is in
# "dependencies", and so is patch-package, because the postinstall runs it
# here too (it skips the .dev patches). The cache is cleared in the
# same layer: npm ci leaves hundreds of MB of tarballs under /root/.npm.
# onnxruntime-node (server-side background removal) ships binaries for six
# platforms; the image keeps only its own (TARGETARCH, which BuildKit sets from
# --platform; the fallback below covers a builder that does not), so the rest
# (~170 MB) go.
# No default on the ARG: a default would shadow BuildKit's value.
ARG TARGETARCH
RUN npm ci --omit=dev && npm cache clean --force \
  && case "${TARGETARCH:-amd64}" in \
    amd64) keep=x64 ;; \
    arm64) keep=arm64 ;; \
    *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && ort=node_modules/onnxruntime-node/bin/napi-v3 \
  && rm -rf "$ort/darwin" "$ort/win32" \
  && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} + \
  && test -d "$ort/linux/$keep"

# The compiled server and the public/ the build generated into.
COPY --from=build /app/dist/ dist/
COPY --from=build /app/public/ public/
# The migrations the app runs at boot (src/db/migrate.ts reads SQL and
# meta/_journal.json from <root>/drizzle).
COPY drizzle ./drizzle
# The seed personas' bibles are the seed's data (src/seed/persona.ts reads
# them from here): `docker exec closet npm run seed -- --persona demo`.
COPY src/seed/personas ./src/seed/personas

# The committed defaults (README, Settings); never .env.local.
COPY .env ./
# The licence travels with the code it covers (MIT; also the image's label).
COPY LICENSE ./

# The server-mode cutout model (MODELS_PATH, 940 MB) is not in the image: it
# is downloaded here on first need. Mount a local volume on it so it is
# fetched once (see README, Background removal).
#
# The process runs as `node` (uid/gid 1000, shipped by node:22-slim), never
# root. What it writes at runtime is exactly these two directories: DATA_PATH
# (/app/data: photos, .incoming/) and MODELS_PATH (/app/models: the
# model's download), so only they are its own; the code and node_modules stay
# root-owned and read-only to it. Production mounts host directories over
# both, and a mount keeps the HOST's ownership: chown them to 1000:1000 there
# (docs/operations.md#permissions). /health/ready's `storage` check reports a
# directory it cannot write, and the boot refuses an unwritable DATA_PATH.
# Everything else it writes is the user's own: HOME is /home/node (npm's
# cache and logs for `docker exec closet npm run ...`), temp files /tmp.
RUN mkdir -p /app/data /app/models && chown node:node /app/data /app/models

# The release identity, passed once by the build (ci.yml publish: the 7-char sha; the PR gate:
# gate-<n>) and reported as /health/ready's `version`, on /about, and as the error tracker's release.
# The image is its only source: compose never sets APP_VERSION (devkit release_check.sh guards
# it). Last in the stage so a new value rebuilds only these layers.
ARG APP_VERSION=dev
ENV NODE_ENV=production APP_VERSION=$APP_VERSION
LABEL org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$APP_VERSION \
      org.opencontainers.image.source=https://github.com/kashhq/closet \
      org.opencontainers.image.licenses=MIT

EXPOSE 3000/tcp

# /health/ready (src/web/health): the database, the boot's migrations, the timers and the cutout
# queue; 503 when a required one is down. node's own fetch, so the slim image needs no curl. The
# start period covers the boot's migrations (the server listens only after them); homelab's
# compose inherits this, and must match it if it ever sets its own (docs/operations.md#health).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health/ready', { signal: AbortSignal.timeout(4000) }).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# Unprivileged, so EXPOSE must stay >= 1024 (devkit release_check.sh: an
# older host kernel refuses a privileged port to non-root). `docker exec`
# runs as this user too, so the CLIs write photos with the server's owner.
USER node

# node itself is PID 1, so `docker stop`'s SIGTERM reaches main.ts, which
# closes the server and the database pool before exiting.
CMD [ "node", "dist/main.js" ]
