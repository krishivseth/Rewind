# Rewind: one Node process serving the API, SSE, agent workers and the built frontend.
FROM node:24-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git python3 python3-venv ca-certificates util-linux \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@10
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY lib ./lib
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/rewind/package.json artifacts/rewind/
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile
COPY artifacts ./artifacts
COPY seed_repos ./seed_repos
RUN pnpm --filter @workspace/api-server run build && pnpm --filter @workspace/rewind run build
RUN mkdir -p /data /tmp/rewind && chown -R node:node /app /data /tmp/rewind
# Stay root only long enough for the entrypoint to chown the volume mount, then drop to node.
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
