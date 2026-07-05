#!/usr/bin/env bash
# Cross-compile the on-device prover to Android .so files for the Expo native module.
# Prereqs: rustup android targets + cargo-ndk + Android NDK.
#   rustup target add x86_64-linux-android aarch64-linux-android
#   cargo install cargo-ndk
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/27.1.12297006}"
OUT="../../mobile/modules/prova-prover/android/src/main/jniLibs"
echo "Building libprova_prover.so (x86_64 emulator + arm64 device) → $OUT"
cargo ndk -t x86_64 -t arm64-v8a -o "$OUT" build --release
echo "Done. Rebuild the app: (cd ../../mobile && npx expo run:android)"
