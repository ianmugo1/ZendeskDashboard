FROM node:20-alpine AS builder

WORKDIR /app
COPY . .

RUN npm ci
RUN npm run build --workspace @zendesk/zendesk-client
RUN npm run build --workspace @zendesk/dashboard-ui

FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app /app

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@zendesk/dashboard-ui"]
