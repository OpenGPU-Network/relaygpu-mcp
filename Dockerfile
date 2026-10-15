# Hosted Relay MCP (Streamable HTTP, stateless). PORT and RELAY_BASE_URL come from the environment per app.
# OAuth ("Connect Relay") is on when the app sets OAUTH_ISSUER and MCP_RESOURCE_URL; OAUTH_MCP_CLIENT_SECRET is the
# same value as Relay's OAUTH_MCP_CLIENT_SECRET in that environment (README → Self-hosting → OAuth). Never baked in.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY agent-setup.md ./
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production PORT=2300 LOG_LEVEL=warning
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 2300
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/http.js"]
