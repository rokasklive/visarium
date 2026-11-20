# One image: the SPA embedded in one static-ish Rust binary.
#
#   docker compose up -d     (see compose.yml)

FROM node:26-alpine AS web
# Node 25+ no longer bundles corepack.
RUN npm install -g corepack && corepack enable
WORKDIR /build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY web/package.json web/
COPY packages/canvas-core/package.json packages/canvas-core/
COPY packages/canvas-renderer-konva/package.json packages/canvas-renderer-konva/
COPY packages/api-client/package.json packages/api-client/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY tsconfig.base.json biome.json CHANGELOG.md ./
COPY packages/ packages/
COPY web/ web/
# prod (default) ships no developer tools at all; dev adds the inspector, for a
# dev environment that runs this same image (`just dev-image`).
ARG WEB_BUILD=prod
RUN if [ "$WEB_BUILD" = dev ]; then pnpm --filter @visarium/web build:dev; \
    else pnpm --filter @visarium/web build && pnpm --filter @visarium/web check:bundle; fi

FROM rust:1-bookworm AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY server/ server/
# A workspace member must exist for the workspace to load; only the server is built.
COPY desktop/ desktop/
# rust-embed bakes the bundle into the release binary at compile time.
COPY --from=web /build/web/dist/ web/dist/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked -p visarium-server && cp target/release/visarium /visarium

FROM debian:bookworm-slim
# CA roots: the server calls OpenID Connect providers over https.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
RUN groupadd -g 1000 visarium && useradd -u 1000 -g visarium -M visarium \
 && mkdir -p /data/db /data/assets /data/derivatives && chown -R visarium:visarium /data
COPY --from=server /visarium /usr/local/bin/visarium
ENV VISARIUM_DATABASE=/data/db/visarium.db \
    VISARIUM_ASSETS_PATH=/data/assets \
    VISARIUM_DERIVATIVES_PATH=/data/derivatives
USER visarium
EXPOSE 8080
# bash's /dev/tcp rather than curl or wget: nothing extra in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/8080 && printf "GET /health/readiness HTTP/1.0\r\n\r\n" >&3 && grep -q UP <&3'
ENTRYPOINT ["/usr/local/bin/visarium"]
