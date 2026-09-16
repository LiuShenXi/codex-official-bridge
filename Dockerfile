# syntax=docker/dockerfile:1.7

FROM rust:1.95.0-bookworm@sha256:6258907abe69656e41cd992e0b705cdcfabcbbe3db374f92ed2d47121282d4a1 AS native-build

ARG TARGETARCH
ARG CARGO_BUILD_JOBS=1
# Use 0 only for an intentional dependency update; export and commit the new lock.
ARG CARGO_LOCKED=1
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_INCREMENTAL=0 \
    CARGO_PROFILE_RELEASE_DEBUG=0 \
    CARGO_PROFILE_RELEASE_OPT_LEVEL=0 \
    CARGO_PROFILE_RELEASE_LTO=false \
    CARGO_PROFILE_RELEASE_STRIP=debuginfo \
    CARGO_NET_GIT_FETCH_WITH_CLI=true \
    GIT_TERMINAL_PROMPT=0 \
    RUSTFLAGS="-C link-arg=-fuse-ld=lld"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates clang cmake git libssl-dev lld pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The tag is convenient for a shallow fetch; the full commit is authoritative.
# No account state, local configuration, or credentials enter the build context.
RUN mkdir -p .runtime/vendor \
    && git clone --depth 1 --single-branch --branch rust-v0.154.0-alpha.6.2 \
       https://github.com/openai/codex.git .runtime/vendor/codex \
    && test "$(git -C .runtime/vendor/codex rev-parse HEAD)" = b5bffd3ec4db487e7e3dec59663875b0ef7b72ca

COPY native-runtime/ native-runtime/

# Only the first native lockfile resolution extends the pinned upstream lock.
# The resulting lockfile is retained in the image for review and reuse.
# Tests here are local Rust boundary tests; they make no model/account calls.
# COPY preserves source timestamps, which can predate cached artifacts. Touch
# the small root crate to rebuild it while retaining the dependency caches.
RUN --mount=type=cache,id=codex-native-registry,target=/usr/local/cargo/registry,sharing=locked \
    --mount=type=cache,id=codex-native-git,target=/usr/local/cargo/git,sharing=locked \
    --mount=type=cache,id=codex-native-target-${TARGETARCH},target=/app/.runtime/native-target,sharing=locked \
    set -eu; \
    if [ ! -f native-runtime/Cargo.lock ]; then \
      cp .runtime/vendor/codex/codex-rs/Cargo.lock native-runtime/Cargo.lock; \
    fi; \
    lock_flag=""; \
    if [ "${CARGO_LOCKED}" = "1" ] && grep -q '^name = "codex-native-runtime"$' native-runtime/Cargo.lock; then lock_flag="--locked"; fi; \
    touch native-runtime/src/main.rs; \
    cargo test --release --jobs "${CARGO_BUILD_JOBS}" ${lock_flag} \
      --manifest-path native-runtime/Cargo.toml --target-dir .runtime/native-target \
      --bin codex-official-runtime; \
    cargo build --release --locked --jobs "${CARGO_BUILD_JOBS}" \
      --manifest-path native-runtime/Cargo.toml --target-dir .runtime/native-target \
      --bin codex-official-runtime; \
    mkdir -p /out; \
    cp .runtime/native-target/release/codex-official-runtime /out/; \
    cp native-runtime/Cargo.lock /out/Cargo.lock

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS node-tests
WORKDIR /app
COPY package.json ./
COPY src/ src/
COPY scripts/ scripts/
COPY examples/ examples/
COPY test/ test/
RUN npm test && npm run check

FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

LABEL io.codex-bridge.upstream.tag="rust-v0.154.0-alpha.6.2" \
      io.codex-bridge.upstream.revision="b5bffd3ec4db487e7e3dec59663875b0ef7b72ca" \
      io.codex-bridge.runtime="official-source-extension"

WORKDIR /app
COPY --from=native-build /out/codex-official-runtime /usr/local/bin/codex-official-runtime
COPY --from=native-build /out/Cargo.lock /usr/local/share/codex-official-runtime/Cargo.lock
COPY --from=node-tests /app/package.json ./
COPY --from=node-tests /app/src/ src/
COPY --from=node-tests /app/scripts/ scripts/
COPY --from=node-tests /app/examples/ examples/
RUN mkdir -p /app/.runtime /var/lib/codex-auth \
    && chown node:node /app/.runtime /var/lib/codex-auth

ENV NODE_ENV=production \
    BRIDGE_MODE=native \
    BRIDGE_PORT=8879 \
    BRIDGE_NATIVE_BIN=/usr/local/bin/codex-official-runtime \
    BRIDGE_CODEX_HOME=/var/lib/codex-auth

# The official login CLI is deliberately absent from the serving image.
# The authenticated, refreshable CODEX_HOME is supplied as a writable mount.
USER node
CMD ["node", "src/main.mjs"]
