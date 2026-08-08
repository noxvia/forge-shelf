# syntax=docker/dockerfile:1.7

# ============================================================================
# Stage 1 — build the Next.js app and generate the Prisma client
# ============================================================================
FROM node:20-bookworm-slim AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# package-lock.json may not exist on a fresh clone; fall back to install.
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npx next build

# Drop dev dependencies but keep the generated Prisma client, prisma CLI and tsx
# (both are runtime dependencies: migrations and the worker need them).
RUN npm prune --omit=dev


# ============================================================================
# Stage 2 — slicer toolchain
#
# Everything here is optional. Build with --build-arg INSTALL_SLICERS=false for
# a much smaller image that can catalogue and send pre-sliced files but cannot
# slice. Release URLs change often; override the *_URL args to pin versions.
# The app reports which binaries are actually present at /api/system/health.
# ============================================================================
FROM debian:bookworm-slim AS slicers

ARG INSTALL_SLICERS=true
ARG ORCA_URL=https://github.com/SoftFever/OrcaSlicer/releases/download/v2.2.0/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.2.0.AppImage
ARG PRUSA_URL=https://github.com/prusa3d/PrusaSlicer/releases/download/version_2.8.1/PrusaSlicer-2.8.1+linux-x64-GTK3-202409181416.AppImage
ARG UVTOOLS_URL=https://github.com/sn4k3/UVtools/releases/download/v4.4.3/UVtools_linux-x64_v4.4.3.AppImage

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# Each fetch is tolerant: a dead URL produces a loud warning instead of a
# failed build, and the corresponding feature simply reports as unavailable.
RUN set -eux; \
    fetch_appimage() { \
      name="$1"; url="$2"; \
      mkdir -p "/opt/$name"; \
      echo "==> fetching $name"; \
      if curl -fSL --retry 3 -o "/tmp/$name.AppImage" "$url"; then \
        chmod +x "/tmp/$name.AppImage"; \
        ( cd /tmp && "/tmp/$name.AppImage" --appimage-extract >/dev/null ) \
          && cp -a /tmp/squashfs-root/. "/opt/$name/" \
          && rm -rf /tmp/squashfs-root "/tmp/$name.AppImage" \
          && echo "==> $name installed"; \
      else \
        echo "!! WARNING: could not download $name from $url — feature disabled"; \
      fi; \
    }; \
    if [ "$INSTALL_SLICERS" = "true" ]; then \
      fetch_appimage orca "$ORCA_URL"; \
      fetch_appimage prusaslicer "$PRUSA_URL"; \
      fetch_appimage uvtools "$UVTOOLS_URL"; \
    else \
      echo "==> INSTALL_SLICERS=false, skipping slicer toolchain"; \
      mkdir -p /opt/orca /opt/prusaslicer /opt/uvtools; \
    fi


# ============================================================================
# Stage 3 — runtime
# ============================================================================
FROM node:20-bookworm-slim AS runtime

ARG INSTALL_SLICERS=true

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    STORAGE_DIR=/data

# openssl: Prisma. The rest are shared libraries the slicer AppImages link
# against; xvfb provides the dummy display OrcaSlicer still wants even when
# slicing headlessly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini \
    && if [ "$INSTALL_SLICERS" = "true" ]; then \
         apt-get install -y --no-install-recommends \
           xvfb \
           libgtk-3-0 libglib2.0-0 libgdk-pixbuf-2.0-0 libpango-1.0-0 libcairo2 \
           libgl1 libglu1-mesa libegl1 libxrandr2 libxi6 libxcursor1 libxinerama1 \
           libxkbcommon0 libsm6 libice6 libdbus-1-3 libnss3 libatk1.0-0 \
           libatk-bridge2.0-0 libcups2 libdrm2 libgbm1 libasound2 \
           libwebkit2gtk-4.0-37 libsoup2.4-1 libssl3 libicu72 \
           fontconfig fonts-dejavu-core ; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=slicers /opt/orca /opt/orca
COPY --from=slicers /opt/prusaslicer /opt/prusaslicer
COPY --from=slicers /opt/uvtools /opt/uvtools

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/src ./src

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
    && mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]
