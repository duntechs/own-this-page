# Own This Page

A private preview of a Solana advertising marketplace with 62 individually buyable spaces. Uses the first approved document-and-cursor logo, mint/forest colours, and a new layout.

This independent project uses owner-only Sites hosting for preview. No Cloudflare account, custom domain, existing marketplace deployment, or previous project's repository is connected. It contains no API key or signing key.

## Preview

`deliverables/own-this-page-preview.html` is a self-contained interactive preview. It includes the page, styling, approved logo, all 62 space details, price overlays, wallet chooser and rules. It has no hosting dependency and always disables payments. Opening this preview does not deploy anything.

## Website source

With Node.js 22.13 or later:

```sh
npm ci
npm run dev
npm run build
npm run test:market
node scripts/make-preview.mjs
```

`dist/` is the standard production frontend. A future host can serve these files. The Sites preview is owner-only. No custom domain or owner Cloudflare account is connected.

## Marketplace rules

- 62 spaces, stable IDs 0–61. The additional directory, note and link sections have been removed.
- Starting prices 0.1–2 SOL based on each space’s fixed catalogue area, rounded to 0.001 SOL.
- Each takeover costs 2× the previous payment. The 2 SOL maximum applies to starting prices only.
- Purchase and takeover payments go to the project treasury. The former owner receives no payout.
- Owners can edit text, public HTTPS images and links; network fees apply. First-time account storage deposits are shown separately.
- The admin can moderate content and lock owner edits. Upgrade authority is retained.
- The official token CA and X account are outside the 62 spaces and cannot be purchased.

Developer, treasury and admin use `8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9`.

Official X: [@ownthispage](https://x.com/ownthispage). The token CA is blank until supplied by the owner. Automatic coin detection remains off.

The owner-selected production domain is `ownthispage.page`. It has not been connected or publicly launched by this source update.

## Current readiness

The site is built but purchases are **not activated**. The 62-space program is compiled and tested locally; no mainnet program has been deployed or verified for this new site. Older binaries and interrupted deployment buffers use a different wallet and must not be reused for this deployment.

Before a future launch, the owner can provide a custom domain and token CA. Neither is required by the slot payment program. A production RPC connection and the newly compiled 62-space program must be deployed and verified. Update `lib/official-project.ts` and `public/market-config.json` only with owner-approved values; keep private RPC credentials out of the browser bundle. Do not set `enabled:true` until the program is actually deployed and its identity verified. This source currently has no browser-based program deployer or private RPC relay; those still need to be supplied for a browser-only launch workflow.

## Independent GitHub setup

The source is published in the owner-approved public repository [duntechs/own-this-page](https://github.com/duntechs/own-this-page), with independent history. Do not import commit history from, or connect deployment settings to, a previous project. The source is ready for a standard GitHub build using `npm ci`, `npm run test:market`, and `npm run build`. The included CI workflow builds and tests only; it has no publishing or wallet credentials and does not deploy.

For a GitHub export, exclude `.openai/hosting.json` (the private preview's hosting identity), Git metadata, generated previews, build caches, dependencies, and all keypairs. Select a new hosting application and domain later. The frontend output directory is `dist`; an active marketplace additionally needs the program and RPC setup described above.

The default public Solana RPC URL is only a credential-free configuration placeholder. The disabled preview does not contact it. No private key, seed phrase, or Helius API key is stored here.

## Program

`solana-market/` includes source, local runtime tests, compiled ELF and a manifest with source and catalogue hashes. See its README for the offline build commands. It has no independent security audit. Successful local tests do not establish live network transaction success.

Do not ship `node_modules`, build caches, `solana-market/target`, or any generated program keypair. Only the ELF, public manifest and lockfile are release artifacts.

## Transaction readiness changes

- The immutable program wallet, client payment recipient, developer, and admin now match the new owner-approved address.
- Explicit compute-unit limit and bounded priority price are included in the reviewed fee; wallets must preserve the transaction message.
- A new blockhash is fetched after the review, before wallet signing. Higher fees or changed slot ownership require another review.
- RPC requests and signing waits have deadlines. The RPC may retry broadcasting the same signed transaction up to three times; the app never automatically signs another payment.
- A public pending receipt is saved before broadcast and restored after reload. Uncertain transactions cannot be dismissed into another purchase; recovery checks confirmed status or finalized expiry before unlocking.
- Local simulator and mocked-wallet tests do not prove mainnet deployment or wallet-extension integration. A successful end-to-end purchase, edit and takeover with the verified deployed program is still required before public launch.
