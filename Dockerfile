FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
COPY config ./config

RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0 DATA_DIR=/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "src/main.ts"]
