FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci --include=dev --include=optional --no-fund --no-audit
COPY app ./app
COPY lib ./lib
COPY components ./components
COPY hooks ./hooks
COPY public ./public
COPY next.config.ts next-env.d.ts tsconfig.json postcss.config.mjs proxy.ts ./
RUN npm run build

FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 APP_SERVER=/app/server.js
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY scripts/init-quota.mjs ./scripts/init-quota.mjs
COPY docker/app-entrypoint.mjs ./docker/app-entrypoint.mjs
COPY LICENSE THIRD_PARTY_NOTICES.md ./
EXPOSE 3000
CMD ["node", "docker/app-entrypoint.mjs"]
