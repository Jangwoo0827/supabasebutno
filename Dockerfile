# syntax=docker/dockerfile:1

# ---- build: compile TypeScript -------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci
COPY packages/server packages/server
RUN npm run build -w @supabasebutno/server

# ---- runtime: production dependencies only, no compilers, non-root -----------------------------------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data
WORKDIR /app

# better-sqlite3 and argon2 ship prebuilt binaries inside their packages (glibc Linux, x64 and arm64), which is why this
# image is Debian-based rather than Alpine. --ignore-scripts stops npm from trying to compile them with node-gyp,
# which would fail here: this image has no compiler.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/
RUN npm ci --omit=dev --ignore-scripts --workspace=@supabasebutno/server && npm cache clean --force

COPY --from=build /app/packages/server/dist packages/server/dist
COPY packages/dashboard/public packages/dashboard/public

# /data holds every database and uploaded file: mount a volume there.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# SIGTERM (docker stop) is handled: connections are closed and databases flushed before exit.
CMD ["node", "packages/server/dist/index.js"]
