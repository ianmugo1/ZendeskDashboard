FROM node:20-alpine AS builder

WORKDIR /app
COPY . .

RUN npm ci
RUN npm run build --workspace @zendesk/zendesk-client
RUN npm run build --workspace @zendesk/worker

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

CMD ["node", "apps/worker/dist/index.js"]
