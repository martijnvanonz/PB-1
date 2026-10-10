FROM node:22-alpine

# The source label links the GHCR package to this repository. If you fork,
# point it at your fork (docker-compose.yml's image: line too).
LABEL org.opencontainers.image.source="https://github.com/martijnvanonz/PB-1" \
      org.opencontainers.image.title="Patchbay" \
      org.opencontainers.image.description="EP-series start page for a Pangolin-fronted homelab."

WORKDIR /app

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV DATA_DIR=/data

RUN mkdir -p /data \
    && chown -R node:node /app /data

USER node

EXPOSE 8288
VOLUME /data

# Uses wget (busybox, built into alpine) instead of curl, which alpine does
# not ship by default. Shell form so $PORT (set via compose) is expanded;
# falls back to 8288 to match the app's own default. start-period gives the
# app time on a slow first boot (e.g. a cold TrueNAS SCALE host) before
# failures count against retries.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8288}/" || exit 1

CMD ["node", "src/server.js"]
