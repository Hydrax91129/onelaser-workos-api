FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc -p tsconfig.build.json
# Optional read-only token for the pinned frontend and Wiki repositories, passed as a BuildKit
# secret so it never lands in an image layer (see deploy/README.md). Without it, downloads are anonymous.
COPY tools/github-fetch-auth.mjs tools/fetch-frontend.mjs ./tools/
COPY deploy/frontend-revision.txt ./deploy/frontend-revision.txt
RUN --mount=type=secret,id=GITHUB_FETCH_TOKEN,dst=/etc/secrets/GITHUB_FETCH_TOKEN \
    node tools/fetch-frontend.mjs /frontend
COPY tools/fetch-wiki.mjs tools/wiki-safety.mjs ./tools/
COPY deploy/wiki-revision.txt ./deploy/wiki-revision.txt
RUN --mount=type=secret,id=GITHUB_FETCH_TOKEN,dst=/etc/secrets/GITHUB_FETCH_TOKEN \
    node tools/fetch-wiki.mjs /wiki
COPY tools/fetch-caldock.mjs ./tools/fetch-caldock.mjs
COPY deploy/caldock-revision.txt ./deploy/caldock-revision.txt
RUN node tools/fetch-caldock.mjs /caldock-source
RUN cd /caldock-source && npm ci --no-audit --no-fund && npm run build

FROM caddy:2 AS edge
# Render drops capabilities; the edge listens on an unprivileged PORT.
# Remove the upstream file capability so execve does not fail with EPERM.
RUN capabilities="$(getcap /usr/bin/caddy)" && \
    if [ -n "$capabilities" ]; then setcap -r /usr/bin/caddy; fi

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=10000 FRONTEND_CONNECTED=true XDG_DATA_HOME=/tmp/caddy-data XDG_CONFIG_HOME=/tmp/caddy-config
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build --chown=node:node /frontend ./public
COPY --from=build --chown=node:node /wiki ./wiki
COPY --from=build --chown=node:node /caldock-source/dist/client ./caldock
COPY --from=edge /usr/bin/caddy /usr/bin/caddy
COPY deploy/Caddyfile deploy/container-start.sh ./deploy/
USER node
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["bash", "/app/deploy/container-start.sh"]
