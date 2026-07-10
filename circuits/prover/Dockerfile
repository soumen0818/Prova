# ZK prover CLI image (arkworks BLS12-381 Groth16). Built separately from the Go backend so the
# heavy Rust/arkworks compile never bloats or slows the API image.
#
# In docker-compose this runs once as `prover-init`: it copies the binary into a shared volume that
# the API/indexer mount and exec to sign KYC credentials (PROVER_BIN). Build context: circuits/prover.
FROM rust:1-bookworm AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --bin prova-prover

FROM debian:bookworm-slim
COPY --from=build /src/target/release/prova-prover /usr/local/bin/prova-prover
# Default command: publish the binary into a mounted volume (/shared) for the API to exec, then exit.
CMD ["sh", "-c", "cp /usr/local/bin/prova-prover /shared/prova-prover && echo 'prova-prover published to /shared'"]
