FROM postgres:17-bookworm AS postgres-tools
RUN mkdir -p /pg-client/bin /pg-client/lib && \
    cp /usr/lib/postgresql/17/bin/pg_dump /usr/lib/postgresql/17/bin/pg_restore /pg-client/bin/ && \
    for tool in pg_dump pg_restore; do \
      ldd "/usr/lib/postgresql/17/bin/$tool" | awk '/=> \// {print $3}' | while read -r library; do \
        case "$library" in */libc.so.*|*/libm.so.*|*/libpthread.so.*|*/libdl.so.*) continue ;; esac; \
        cp -L "$library" /pg-client/lib/; \
      done; \
    done

FROM node:22-bookworm-slim AS base
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
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
RUN mkdir -p /app/data/storage && chown -R node:node /app/data /app/.next
USER node
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["npm", "start", "--", "--hostname", "0.0.0.0"]
