# Production image: the API server also serves the built web app (one container, one URL).
# Works on any Docker host (listens on port 7860; set PORT to change it).
# The database is external (e.g. a free Neon PostgreSQL): set DATABASE_URL and GEMINI_API_KEY.

# ---- Build: install everything, compile shared + server + web, then drop dev dependencies.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --include=dev
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- Run: only what the server needs.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=7860 \
    LOG_LEVEL=info
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/package.json ./shared/
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/server/package.json ./server/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/migrations ./server/migrations
COPY --from=build /app/web/dist ./web/dist
USER node
EXPOSE 7860
CMD ["node", "server/dist/index.js"]
