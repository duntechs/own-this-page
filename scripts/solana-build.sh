#!/usr/bin/env bash
set -euo pipefail

solana_repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$solana_repo_root"
command -v cargo-build-sbf >/dev/null
command -v cargo >/dev/null
command -v node >/dev/null
# Set SOLANA_BUILD_OFFLINE=1 when using a preinstalled toolchain and Cargo cache.
# This affects compilation and simulator tests only; this script never deploys.
solana_sbf_flags=()
solana_cargo_flags=(--locked)
if [[ "${SOLANA_BUILD_OFFLINE:-0}" == "1" ]]; then
  solana_sbf_flags+=(--offline --skip-tools-install)
  solana_cargo_flags+=(--offline)
fi
# Honor the crate's Rust 1.84 minimum when first resolving transitive packages;
# the pinned SBF compiler cannot parse edition-2024-only dependencies.
export CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=fallback
solana_sbf_output="$solana_repo_root/solana-market/target/deploy"
solana_public_output="$solana_repo_root/solana-market/artifacts"
mkdir -p "$solana_sbf_output" "$solana_public_output"

# The reviewed lock includes SBF-compatible transitive versions. Do not silently
# replace it with whatever versions happen to be newest during a production build.
if [[ ! -f solana-market/Cargo.lock ]]; then
  printf '%s\n' 'Missing solana-market/Cargo.lock; restore the reviewed dependency lock before building.' >&2
  exit 1
fi
cargo-build-sbf --manifest-path solana-market/Cargo.toml \
  --tools-version v1.48 --sbf-out-dir "$solana_sbf_output" \
  "${solana_sbf_flags[@]}" -- "${solana_cargo_flags[@]}"
test -s "$solana_sbf_output/slot_market.so"
SLOT_MARKET_SO="$solana_sbf_output/slot_market.so" \
  cargo test --manifest-path solana-market/Cargo.toml "${solana_cargo_flags[@]}"

# cargo-build-sbf generates a disposable program keypair beside the binary.
# Only the binary and public records are copied; no keypair is published or used.
node scripts/solana-build-manifest.mjs "$solana_sbf_output/slot_market.so" "$solana_public_output"
