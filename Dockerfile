FROM node:22-bookworm-slim AS ui-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY ui/package.json ./ui/package.json
RUN npm ci && npm cache clean --force
COPY ui/src ./ui/src
COPY ui/scripts/build.mjs ./ui/scripts/build.mjs
RUN npm run build:ui

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --workspaces=false && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public/objy-db-logo.png ./public/
COPY --from=ui-build --chown=node:node /build/public/ui ./public/ui
COPY --chown=node:node API.md README.md LICENSE NOTICE.md ./
COPY --chown=node:node objydb.config.json ./objydb.config.json

RUN mkdir -p /var/lib/objydb/wal && chown -R node:node /var/lib/objydb

USER node
WORKDIR /var/lib/objydb
EXPOSE 8080

CMD ["node", "/app/src/index.js", "--config", "/app/objydb.config.json"]
