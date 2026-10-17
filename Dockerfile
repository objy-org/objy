FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node bin ./bin
COPY --chown=node:node client ./client
COPY --chown=node:node plugins ./plugins
COPY --chown=node:node public ./public
COPY --chown=node:node API.md ./API.md

RUN mkdir -p /var/lib/objydb/wal && chown -R node:node /var/lib/objydb

USER node
EXPOSE 8080

CMD ["node", "bin/objydb.js"]
