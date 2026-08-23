# Multi-stage build for the Prova backend (Go API + indexer — same image, RUN_MODE selects the role).
#
# IMPORTANT: the build context is the repo ROOT, not backend/, because backend/go.mod replaces
# github.com/prova/shared with ../shared/go — that module must be inside the context. Build with:
#
#   docker build -f backend/Dockerfile -t prova-backend .
#
FROM golang:1.25-alpine AS build
WORKDIR /src

# The replaced local module must be present before `go mod download`/build resolves it.
COPY shared/go/ ./shared/go/

# Download external deps first (cached layer keyed on go.mod/go.sum).
COPY backend/go.mod backend/go.sum ./backend/
WORKDIR /src/backend
RUN go mod download

# Build a static binary.
COPY backend/ ./
RUN CGO_ENABLED=0 go build -o /out/api ./cmd/api

# Fetch the Stellar CLI (the transfer relayer signs/submits via it — see internal/chain). It's a
# lightweight prebuilt glibc binary, so we just download it rather than build from source.
FROM debian:bookworm-slim AS stellar-cli
ARG STELLAR_CLI_VERSION=27.0.0
ARG TARGETARCH=amd64
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && arch="x86_64"; [ "$TARGETARCH" = "arm64" ] && arch="aarch64"; \
    curl -sSL "https://github.com/stellar/stellar-cli/releases/download/v${STELLAR_CLI_VERSION}/stellar-cli-${STELLAR_CLI_VERSION}-${arch}-unknown-linux-gnu.tar.gz" -o /tmp/scli.tgz \
    && tar xzf /tmp/scli.tgz -C /usr/local/bin stellar \
    && rm /tmp/scli.tgz

# Runtime: debian-slim (glibc + a shell) so the API can exec the Stellar CLI (relay) and the KYC
# prover binary provided at runtime via a shared volume (see docker-compose).
#
#   ca-certificates — outbound HTTPS to Soroban RPC / Horizon / the anchor.
#   libdbus-1-3     — REQUIRED BY THE STELLAR CLI, which is dynamically linked against it for the
#                     OS keyring it uses to store identities. The relayer passes a raw secret key
#                     and never touches the keyring, but the dependency is resolved at load time,
#                     not on use: without it every invocation dies before running with
#                     "error while loading shared libraries: libdbus-1.so.3".
#
# That failure cost real time to find. `stellar` was present and executable, so the image looked
# correct; the folder proved each batch successfully and then failed at submission, so deposits sat
# at "confirming" indefinitely while nothing on-chain showed an attempt. Verified with `ldd` inside
# this exact base image — libdbus is the only unmet dependency.
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libdbus-1-3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/api /usr/local/bin/api
COPY --from=stellar-cli /usr/local/bin/stellar /usr/local/bin/stellar
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
