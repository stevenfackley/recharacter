# Next.js web app — standalone output, runtime-configured.
# All config is runtime env (see deploy/env.example); the build opens no connections.

FROM node:26-alpine AS deps
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci

FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY web/ ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:26-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
EXPOSE 3000
USER node
CMD ["node", "server.js"]
