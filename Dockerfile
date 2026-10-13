FROM postgres:17-bookworm AS postgres-tools
RUN mkdir -p /pg-client/bin /pg-client/lib && \
    cp /usr/lib/postgresql/17/bin/pg_dump /usr/lib/postgresql/17/bin/pg_restore /pg-client/bin/ && \
    for tool in pg_dump pg_restore; do \
      ldd "/usr/lib/postgresql/17/bin/$tool" | awk '/=> \// {print $3}' | while read -r library; do \
        case "$library" in */libc.so.*|*/libm.so.*|*/libpthread.so.*|*/libdl.so.*) continue ;; esac; \
        cp -L "$library" /pg-client/lib/; \
      done; \
    done

FROM node:22-bookworm-slim AS system
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    rm -f /etc/apt/apt.conf.d/docker-clean && \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 update && \
    apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 install -y --no-install-recommends ca-certificates && \
    sed -i 's|http://deb.debian.org/|https://deb.debian.org/|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 update && \
    apt-get -o Acquire::Retries=3 -o Acquire::https::Timeout=30 install -y --no-install-recommends ffmpeg espeak-ng
COPY --from=postgres-tools /pg-client /opt/pg17
RUN for tool in pg_dump pg_restore; do \
      printf '#!/bin/sh\nLD_LIBRARY_PATH=/opt/pg17/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} exec /opt/pg17/bin/%s "$@"\n' "$tool" > "/usr/local/bin/$tool"; \
      chmod 755 "/usr/local/bin/$tool"; \
    done && pg_dump --version && pg_restore --version
WORKDIR /app

FROM system AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=speak-npm,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts --no-fund --no-audit --fetch-retries=2 --fetch-timeout=120000

FROM dependencies AS builder
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 SPEAK_STANDALONE=1
RUN npm run build
# The runtime receives complete production dependencies below, not traced duplicates.
RUN test -f /app/.next/standalone/server.js && rm -rf /app/.next/standalone/node_modules

FROM system AS production-dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,id=speak-npm,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts --no-fund --no-audit --fetch-retries=2 --fetch-timeout=120000

FROM system AS runtime
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json /app/next.config.ts ./
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/db ./db
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/content ./content
COPY --from=builder /app/public ./public
COPY --from=builder /app/LICENSE /app/THIRD_PARTY_NOTICES.md ./
RUN mkdir -p /app/data/storage && chown -R node:node /app/data /app/.next
USER node
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000
CMD ["node", "server.js"]
