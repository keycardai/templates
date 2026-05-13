FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist/ dist/

ENV PORT=9000
ENV AGENT_KEYS_DIR=/data/agent_keys

EXPOSE 9000

CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
