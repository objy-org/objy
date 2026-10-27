FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node client ./client
COPY --chown=node:node public/index.html public/objy-db-logo.png ./public/
COPY --chown=node:node API.md README.md LICENSE NOTICE.md ./
COPY --chown=node:node spread-db.config.json ./spread-db.config.json

RUN mkdir -p /var/lib/objydb/wal && chown -R node:node /var/lib/objydb

USER node
WORKDIR /var/lib/objydb
EXPOSE 8080

CMD ["node", "/app/bin/objydb.js", "--config", "/app/spread-db.config.json"]
