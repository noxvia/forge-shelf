# syntax=docker/dockerfile:1.7

# ============================================================================
# Stage 1 — build the Next.js app and generate the Prisma client
# ============================================================================
FROM node:22-trixie-slim AS build

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
# Stage 2 — slicer toolchain (AppImage half)
#
# Build with --build-arg INSTALL_SLICERS=false for a much smaller image that can
# catalogue and send pre-sliced files but cannot slice.
#
# These fetches fail the build if a URL dies. An earlier version only warned,
# which produced a 3 GB image that silently could not slice — strictly worse
# than a red build. If a URL has moved, override the matching *_URL arg.
#
# PrusaSlicer is deliberately absent here: Prusa stopped publishing Linux
# AppImages on GitHub, so it comes from Debian in the runtime stage instead.
# ============================================================================
FROM debian:bookworm-slim AS slicers

ARG INSTALL_SLICERS=true
ARG ORCA_URL=https://github.com/SoftFever/OrcaSlicer/releases/download/v2.4.2/OrcaSlicer_Linux_AppImage_Ubuntu2404_V2.4.2.AppImage
ARG UVTOOLS_URL=https://github.com/sn4k3/UVtools/releases/download/v6.2.0/UVtools_linux-x64_v6.2.0.AppImage

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

RUN set -eux; \
    fetch_appimage() { \
      name="$1"; url="$2"; \
      mkdir -p "/opt/$name"; \
      echo "==> fetching $name from $url"; \
      curl -fSL --retry 3 -o "/tmp/$name.AppImage" "$url"; \
      chmod +x "/tmp/$name.AppImage"; \
      ( cd /tmp && "/tmp/$name.AppImage" --appimage-extract >/dev/null ); \
      cp -a /tmp/squashfs-root/. "/opt/$name/"; \
      rm -rf /tmp/squashfs-root "/tmp/$name.AppImage"; \
      echo "==> $name installed"; \
    }; \
    if [ "$INSTALL_SLICERS" = "true" ]; then \
      fetch_appimage orca "$ORCA_URL"; \
      fetch_appimage uvtools "$UVTOOLS_URL"; \
      # .NET debug symbols ship in the AppImage and are dead weight in a
      # container. The verification gate below still exercises the binary.
      find /opt/uvtools -name '*.pdb' -delete; \
      # Prove the extraction produced what the app expects, rather than
      # discovering it is missing at the first slice.
      test -x /opt/orca/AppRun; \
      test -f /opt/uvtools/usr/bin/UVtoolsCmd; \
      echo "==> AppImage slicers verified"; \
    else \
      echo "==> INSTALL_SLICERS=false, skipping slicer toolchain"; \
      mkdir -p /opt/orca /opt/uvtools; \
    fi


# ============================================================================
# Stage 3 — runtime
# ============================================================================
#
# Trixie, not bookworm, and not by preference: OrcaSlicer 2.4.2 is built against
# Ubuntu 24.04 and needs glibc 2.38+/GLIBCXX_3.4.32. Bookworm ships glibc 2.36,
# so the binary refuses to start there. Trixie's 2.41 runs it, and brings
# prusa-slicer 2.9.2 (vs 2.5.0) and native WebKitGTK 4.1 along with it.
FROM node:22-trixie-slim AS runtime

ARG INSTALL_SLICERS=true

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    STORAGE_DIR=/data

# openssl: Prisma. The rest are shared libraries the slicer AppImages link
# against; xvfb provides the dummy display OrcaSlicer still wants even when
# slicing headlessly.
# openssl: Prisma. prusa-slicer: Debian's package, which is how SLA slicing is
# obtained now that upstream no longer ships a Linux AppImage — 2.5.0 is older
# than current upstream but is packaged, patched and pulls its own dependencies.
# The library list is for the OrcaSlicer AppImage, which bundles nothing; xvfb
# provides the dummy display it still wants even when slicing headlessly.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini \
    && if [ "$INSTALL_SLICERS" = "true" ]; then \
         apt-get install -y --no-install-recommends \
           prusa-slicer \
           xvfb xauth \
           libgtk-3-0t64 libglib2.0-0t64 libgdk-pixbuf-2.0-0 libpango-1.0-0 \
           libcairo2 libgl1 libglu1-mesa libegl1 libxrandr2 libxi6 libxcursor1 \
           libxinerama1 libxkbcommon0 libsm6 libice6 libdbus-1-3 libnss3 \
           libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libgbm1 \
           libasound2t64 \
           libwebkit2gtk-4.1-0 libjavascriptcoregtk-4.1-0 libsoup2.4-1 \
           fontconfig fonts-dejavu-core ; \
       fi \
    && rm -rf /var/lib/apt/lists/*

COPY --from=slicers /opt/orca /opt/orca
COPY --from=slicers /opt/uvtools /opt/uvtools

# Gate the build on every slicer actually *running*, not merely existing.
#
# Checking for the file is not enough: an earlier build had all three files in
# place while OrcaSlicer aborted on a missing WebKitGTK and xvfb-run aborted on a
# missing xauth. Both only surfaced when a user tried to slice. Executing each
# one here turns those into build failures.
#
# Probes match on expected *output*, not exit status: UVtoolsCmd --help exits 1
# even when perfectly healthy, so an exit-code gate would fail good builds. A
# binary that dies on a missing shared library prints an error instead of usage
# text, so output matching still catches the real failure.
RUN if [ "$INSTALL_SLICERS" = "true" ]; then \
      set -e; \
      echo "==> verifying slicer toolchain"; \
      chmod +x /opt/uvtools/usr/bin/UVtoolsCmd; \
      \
      probe() { \
        name="$1"; pattern="$2"; shift 2; \
        if "$@" 2>&1 | grep -qiE "$pattern"; then \
          echo "    $name ok"; \
        else \
          echo "FATAL: $name did not start correctly. First lines of its output:"; \
          "$@" 2>&1 | head -5 | sed 's/^/      /'; \
          exit 1; \
        fi; \
      }; \
      \
      command -v prusa-slicer >/dev/null || { echo "FATAL: prusa-slicer not installed"; exit 1; }; \
      probe "prusa-slicer" "usage|--export|prusaslicer" prusa-slicer --help; \
      \
      xvfb-run -a true || { echo "FATAL: xvfb-run is broken — is xauth installed?"; exit 1; }; \
      echo "    xvfb-run     ok"; \
      \
      # The Orca pattern must not contain "orca": its failure message includes
      # the path /opt/orca/bin/orca-slicer, so a loose pattern matched the very
      # error it was meant to catch and passed a build where Orca could not run
      # at all. Match only text that appears in genuine usage output.
      probe "orcaslicer " "^Usage: orca-slicer|--slice option" xvfb-run -a /opt/orca/AppRun --help; \
      probe "uvtools    " "convert|usage|command" /opt/uvtools/usr/bin/UVtoolsCmd --help; \
      \
      # Prove the vendor presets Orca inherits from are actually in the image;
      # without them every Bambu profile fails at slice time, not build time.
      test -d /opt/orca/resources/profiles/BBL/machine \
        || { echo "FATAL: OrcaSlicer vendor profiles missing"; exit 1; }; \
      echo "    presets      ok ($(ls /opt/orca/resources/profiles | wc -l) vendors)"; \
      \
      echo "==> slicer toolchain verified"; \
    fi

WORKDIR /app

# Ownership is set during the copy. A later `chown -R` on /app would rewrite
# every file's metadata, and overlayfs stores that as a full second copy of
# node_modules and .next — 662 MB of pure duplication in the published image.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/next.config.mjs ./next.config.mjs
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/src ./src

COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# Only /data needs chown, and it is empty at this point.
RUN mkdir -p /data && chown node:node /data

USER node

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["web"]
