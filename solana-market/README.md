# Own This Page — native Solana market

This program implements the 62 advertising spaces using native SOL payments.
Initial prices span 0.1–2 SOL, scaled by the existing slot dimensions and rounded
to 0.001 SOL. Each takeover costs twice the last paid price. Every purchase pays
the fixed treasury; previous owners receive no payout.

Dev, treasury, and moderation admin are the same immutable address in this
program binary:

```
8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9
```

The client/program interface is documented in [ABI.md](ABI.md). The program ID
is assigned at deployment and is separate from any token mint. The market
does not launch a token, watch a launchpad, approve SPL tokens, or migrate
balances or ownership from another marketplace. The official CA and X link are not among the
62 market slot IDs (0–61). ID 62 and all larger IDs are rejected.

## Build and transaction tests

From the repository root, the Solana build script runs the SBF compiler, then
executes the produced `slot_market.so` using LiteSVM. The corresponding manual
commands, with Rust and the Solana/Agave toolchain installed, are:

```sh
cargo build-sbf --manifest-path solana-market/Cargo.toml
SLOT_MARKET_SO="$PWD/solana-market/target/deploy/slot_market.so" \
  cargo test --manifest-path solana-market/Cargo.toml
```

The complete reproducible workflow is `bash scripts/solana-build.sh`, using
Agave 2.2.20, platform tools v1.48, and the committed Cargo dependency lock.
With those tools and dependencies already cached, run
`SOLANA_BUILD_OFFLINE=1 bash scripts/solana-build.sh` to prevent network access.
After the runtime tests pass, this writes the binary and a manifest containing
the 62 prices, source hashes, and binary hash to `solana-market/artifacts`.
The build command does not contact a wallet, deploy a program, or publish a site.

The runtime tests cover SOL routing, first-account rent, takeover pricing,
stale quotes, owner authorization, moderation, signature rejection, substituted
accounts, prefunded PDAs, content validation, arithmetic overflow, and atomic
rollback. They execute the compiled program, including its System Program
calls. Every one of the 62 spaces is purchased in the simulator and checked
against its catalog price; the highest valid ID also exercises editing and a
2× takeover. They do not send transactions to a public network.

Ordinary transaction tests keep signature verification enabled. Successful
moderation tests use one clearly marked simulator fixture with signature
verification disabled for the public fixed admin address, since its private
key is not available to the test suite. Signer requirements and wrong-admin
rejection are tested separately with verification enabled. No alternate admin
or test private key is embedded in the deployable program.

## Deployment boundary

A successful build/test does not deploy the program. Program deployment needs
the owner's Solana wallet authorization and sufficient SOL for deployment rent
and network fees. Keep the website's payments disabled until its network,
program address, published artifact hash, fixed treasury, and price catalog
have been verified against the intended deployment. The program has no mutable
initializer to claim; each slot is created by its first purchase or admin edit.
Older binaries use a different immutable wallet. Their deployment addresses or
upload progress must not be reused for this program, even if the slot count matches.

Only public build outputs should be distributed. Never publish a generated
`*-keypair.json` or wallet secret. A loader upgrade authority, if retained at
deployment, can replace program code; changing the binary requires a new review
and a new verified frontend artifact hash. Tests are not an independent audit.
