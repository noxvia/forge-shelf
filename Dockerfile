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
# (both are runtime dependencies: schema sync and the worker need them).
RUN npm prune --omit=dev


# ============================================================================
# Stage 2 — UVtools
#
# Slicing happens in the user's desktop slicer. UVtools stays because it is not
# a slicer: it inspects already-sliced files for resin traps, islands and
# suction cups, including files produced by ChiTuBox or Lychee and uploaded here.
#
# Build with --build-arg INSTALL_TOOLS=false to omit it; the app then reports
# inspection as unavailable rather than failing mysteriously.
# ============================================================================
FROM debian:trixie-slim AS uvtools

ARG INSTALL_TOOLS=true
ARG UVTOOLS_URL=https://github.com/sn4k3/UVtools/releases/download/v6.2.0/UVtools_linux-x64_v6.2.0.AppImage

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates file \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# A dead URL fails the build. An earlier version only warned, and shipped an
# image that silently could not do its job — strictly worse than a red build.
RUN set -eux; \
    if [ "$INSTALL_TOOLS" = "true" ]; then \
      mkdir -p /opt/uvtools; \
      curl -fSL --retry 3 -o /tmp/uvtools.AppImage "$UVTOOLS_URL"; \
      chmod +x /tmp/uvtools.AppImage; \
      ( cd /tmp && /tmp/uvtools.AppImage --appimage-extract >/dev/null ); \
      cp -a /tmp/squashfs-root/. /opt/uvtools/; \
      rm -rf /tmp/squashfs-root /tmp/uvtools.AppImage; \
      # .NET debug symbols are dead weight in a container.
      find /opt/uvtools -name '*.pdb' -delete; \
      test -f /opt/uvtools/usr/bin/UVtoolsCmd; \
      echo "==> UVtools installed"; \
    else \
      echo "==> INSTALL_TOOLS=false, skipping UVtools"; \
      mkdir -p /opt/uvtools; \
    fi


# ============================================================================
# Stage 3 — runtime
# ============================================================================
FROM node:22-trixie-slim AS runtime

ARG INSTALL_TOOLS=true

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    STORAGE_DIR=/data

# openssl is for Prisma. Python carries the mesh work: plate export, inspection
# and the editing plugins. No GUI toolkit is needed any more — nothing here
# opens a window.
#
# libicu is not optional despite that: UVtools is a .NET application and its
# runtime aborts at startup without it ("Couldn't find a valid ICU package").
# It used to arrive as a transitive dependency of the GTK stack, so removing
# that stack broke UVtools — caught by the build gate rather than by a user.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini \
    && if [ "$INSTALL_TOOLS" = "true" ]; then \
         apt-get install -y --no-install-recommends python3 python3-pip libicu76 ; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# manifold3d      — boolean engine trimesh subtracts with (drain holes, splitting)
# rtree           — spatial index trimesh's ray casting needs; without it hole
#                   placement dies with "No module named 'rtree'" at run time
# networkx + lxml — what trimesh's 3MF *reader* needs. Our writer needs neither,
#                   but reading 3MF back is how uploads get their mesh stats and
#                   how plate items load.
RUN if [ "$INSTALL_TOOLS" = "true" ]; then \
      pip install --break-system-packages --no-cache-dir \
        trimesh==4.5.3 manifold3d==3.0.1 rtree==1.3.0 \
        networkx==3.4.2 lxml==5.3.0 numpy ; \
    fi

COPY --from=uvtools /opt/uvtools /opt/uvtools

# Copied ahead of the rest of the source so the gate below can run the real
# scripts. The full src copy later supersedes this.
COPY src/tools /app/src/tools

# The gate lives in a script rather than inline: a heredoc cannot be mixed with
# backslash continuations in a RUN, and the check is worth reading on its own.
RUN if [ "$INSTALL_TOOLS" = "true" ]; then sh /app/src/tools/verify-tools.sh; fi

WORKDIR /app

# Ownership is set during the copy. A later `chown -R` on /app would rewrite
# every file's metadata, and overlayfs stores that as a full second copy of
# node_modules and .next.
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
