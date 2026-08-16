# --- build ------------------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /repo

# The shared package first: it is a local dependency that must exist and be compiled before the web
# app can typecheck or build against it.
COPY shared/package.json shared/package-lock.json ./shared/
RUN cd shared && npm ci
COPY shared/ ./shared/
RUN cd shared && npm run build

# Dependencies before source, so a change to a page does not reinstall node_modules.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci

COPY web/ ./web/
# `next build` refuses to start without a session secret (see lib/session.ts). Set inline for this
# one command rather than as ENV, so it signs nothing, reaches no layer, and cannot be mistaken for
# a real value. The runtime secret comes from the environment.
RUN cd web && OPS_SESSION_SECRET=build-only-placeholder npm run build

# --- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Runs unprivileged: this process is reachable from the internet, and there is nothing it needs root
# for. `node` already exists in the base image.
USER node

# `standalone` carries its own minimal node_modules and its own server.js; static/ and public/ are
# not traced into it and must be copied alongside, or every asset 404s while the pages render fine.
#
# The layout inside standalone mirrors the build's tracing root. Next picked web/ (not the repo
# root), so server.js sits at the top and the asset paths are flat — copying them a directory deeper
# leaves node looking for a server.js that is not there.
COPY --from=build --chown=node:node /repo/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/web/.next/static ./.next/static
COPY --from=build --chown=node:node /repo/web/public ./public

EXPOSE 3000
CMD ["node", "server.js"]
