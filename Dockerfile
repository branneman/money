# The image of the sync and of the app's server: their source as it is in the repository,
# and nothing else.
# Node runs the TypeScript directly, so there is no build. docs/infra.md has the reasoning.
FROM node:24.22.1-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared shared
COPY sync sync
COPY server server
# Creates node_modules/@money, the links Node resolves the workspaces by. Nothing
# third-party is installed: the server has no runtime dependency, and the development tools
# are left out.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY bin/money /usr/local/bin/money

# A new volume takes its ownership from the directory it is first mounted over.
RUN mkdir /data /state /app-data /app/client && chown node:node /data /state /app-data \
    && chmod 700 /app-data
# DATA_DIR and STATE_DIR are not set here: the server refuses to start with STATE_DIR in its
# environment, and its container inherits the image's. bin/money gives them to the sync.
ENV APP_DATA_DIR=/app-data CLIENT_DIR=/app/client PORT=8080

USER node

ARG REVISION=unknown
ENV REVISION=${REVISION}
LABEL org.opencontainers.image.source="https://github.com/branneman/money" \
      org.opencontainers.image.revision="${REVISION}"

# The server listens here. The default command stays idle: the web container is started
# with `money serve`, which is the host's declaration.
EXPOSE 8080

# The container is there to be run in. Nothing in it answers a signal, and a run that is
# killed is safe, so a stop need not wait.
STOPSIGNAL SIGKILL
CMD ["sleep", "infinity"]
