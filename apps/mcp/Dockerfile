FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 NEUROMEM_MCP_STATE_DIR=/var/lib/neuromem-mcp
WORKDIR /app
COPY package.json ./
COPY --from=build /app/dist ./dist
USER root
RUN mkdir -p /var/lib/neuromem-mcp && chown -R node:node /var/lib/neuromem-mcp
VOLUME ["/var/lib/neuromem-mcp"]
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O - http://127.0.0.1:3001/health >/dev/null || exit 1
CMD ["node", "dist/src/http.js"]
