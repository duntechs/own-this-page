# Own This Page

A Solana advertising marketplace with 62 individually buyable spaces. Uses the first approved document-and-cursor logo, mint/forest colours, and a new layout.

This independent project has its own GitHub source and Cloudflare Worker configuration. The optional Sites preview remains owner-only. It contains no API key or signing key and does not reuse another marketplace deployment.

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

`dist/` contains the production frontend and the pinned program artifact. The Cloudflare Worker serves these assets and the private RPC relay. The Sites preview is owner-only.

## Marketplace rules

- 62 spaces, stable IDs 0–61. The additional directory, note and link sections have been removed.
- Starting prices 0.1–2 SOL based on each space’s fixed catalogue area, rounded to 0.001 SOL.
- Each takeover costs 2× the previous payment. The 2 SOL maximum applies to starting prices only.
- Purchase and takeover payments go to the project treasury. The former owner receives no payout.
- Owners can edit text, upload raster images directly or use public HTTPS image links; network fees apply. First-time account storage deposits are shown separately.
- The admin can moderate content and lock owner edits. Upgrade authority is retained.
- The official token CA and X account are outside the 62 spaces and cannot be purchased.

Developer, treasury and admin use `8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9`.

Official X: [@ownthispage](https://x.com/ownthispage). The token CA is blank until supplied by the owner. Automatic coin detection remains off.

The owner-selected production domain is `ownthispage.page`. The domain must be connected to the new `own-this-page` Worker in Cloudflare.

## Current readiness

The site is built but purchases are **not activated**. The 62-space program is compiled and tested locally; no mainnet program has been deployed or verified for this new site. Older binaries and interrupted deployment buffers use a different wallet and must not be reused for this deployment.

The browser deployment page is `/?setup=1` (also linked from Owner info). It uses the pinned compiled program and the connected admin wallet. The Cloudflare Worker provides a bounded private Helius RPC relay. Wallet approval is required; publishing this repository does not deploy the program or activate purchases.

### Cloudflare and Helius

1. Connect only `duntechs/own-this-page` to a new Worker named `own-this-page`.
2. Set build command `npm run build` and deploy command `npx wrangler deploy`. The committed `wrangler.jsonc` includes the Worker, assets, and rate-limit bindings. The earlier command with `--name own-this-page --assets ./dist --compatibility-date 2026-09-15` also discovers this config.
3. In that Worker's **Settings → Runtime variables and secrets**, create **Secret** `HELIUS_RPC_URL` with the full mainnet RPC URL copied from Helius. Use `https://mainnet.helius-rpc.com/?api-key=...`, with your actual key. Save and deploy. Build-time variables are not runtime secrets. Never put this value in GitHub, a `VITE_` variable, or public configuration.
4. Connect `ownthispage.page` in the new Worker's Domains section. Use that same website address and browser throughout deployment so its saved recovery record remains available.
5. Open `/?setup=1`. The connection check must confirm Solana mainnet before deployment can start.

### Direct image uploads

No ChatGPT Cloudflare integration is required. In the Cloudflare dashboard:

1. Enable **R2 Object Storage** for this account. Review any Cloudflare plan or billing prompt yourself.
2. In the new Worker's build settings, change the deploy command to `npx wrangler deploy --config wrangler.images.jsonc` and run a new build.
3. Wrangler provisions an independent image bucket and binds it as `IMAGES`. Future deployments reuse that binding. Keep using the image configuration so the binding remains connected.
4. `/api/images/health` should return `{"configured":true}`. The placement editor then enables **Upload an image**. The default `wrangler.jsonc` can deploy without R2; uploads remain unavailable until storage is connected.

Uploads accept PNG, JPG, and WebP files up to 3 MB. The wallet signs a short-lived message for the exact image and website, without sending SOL. Images are public and stored under a content hash; uploading does not buy or edit a placement until the user approves the separate marketplace transaction. URLs stay stable and duplicate uploads reuse the same file. The API validates signatures and image types, limits request sizes, and rate-limits uploads. Existing HTTPS image links remain supported.

### Deploy the marketplace

Connect the approved admin wallet, check a fresh deployment estimate, review the SOL reserve, then approve deployment. The wallet signs version-0 transactions in batches of at most five. Seeded program and buffer accounts require only the admin signature; their recovery seeds are public and no additional private key is stored.

The estimate separates program deposits, temporary upload funds, and a conservative network-fee reserve. It is not a promise of a fixed mainnet cost. Upload funding is returned during successful final deployment; on-chain program deposits remain allocated. Keep the tab open for wallet approvals. If interrupted, resume on the same origin/browser: signed receipts and uploaded bytes are checked first. Do not clear browser site data or start another deployment to work around an unresolved transaction.

Every submitted packet is saved before broadcast. Expired transactions require finalized expiry evidence and account reconciliation before fresh signing. Different messages or invalid wallet signatures are rejected; retries use the same approved signed bytes. The final program must match the exact release and retained admin upgrade authority.

New signing requests get a fresh confirmed blockhash after the unsigned checks. The signed transactions must still pass verification, fee bounds and simulation, and have enough remaining block height before broadcast. A near-expiry approval pauses without submitting that group; signed or unresolved packets are never silently given a new blockhash.

If deployment pauses, the page refreshes the actual uploaded bytes and offers **Copy deployment status** without requiring wallet approval. The report contains public account IDs and bounded summaries for the latest group, including transaction signatures, RPC acknowledgments and checked outcomes. RPC acknowledgment is not confirmation. Reports exclude raw transactions, recovery seeds and RPC credentials. Older saved deployments may lack archived details for receipts already cleared by a previous version; their uploaded bytes and remaining signed receipts are still checked normally.

After verification, copy the public program address or deployment report into the project conversation. No ZIP download is needed. It is a marketplace program address, separate from the token CA. Verification does not automatically enable public purchases.

### Activate after verification

Update `public/market-config.json` with the verified program ID, release hash and byte length, and the production website RPC URL (`https://ownthispage.page/api/rpc`). Keep the immutable wallet and price settings. First validate purchase, edit, takeover and treasury receipts with controlled wallet tests. Publish `enabled:true` only for the verified release after the launch checks. `lib/official-project.ts` controls the separately supplied official token CA; no token launch is required.

The browser deployer is implemented, but a mainnet deployment and real wallet-extension end-to-end verification are still required. The owner signs all mainnet transactions in their wallet.

## Independent GitHub setup

The source is published in the owner-approved public repository [duntechs/own-this-page](https://github.com/duntechs/own-this-page), with independent history. Do not import commit history from, or connect deployment settings to, a previous project. The source is ready for a standard GitHub build using `npm ci`, `npm run test:market`, and `npm run build`. The included CI workflow builds and tests only; it has no publishing or wallet credentials and does not deploy.

For a GitHub export, exclude `.openai/hosting.json` (the private preview's hosting identity), Git metadata, generated previews, build caches, dependencies, and all keypairs. Select a new hosting application and domain later. The frontend output directory is `dist`; an active marketplace additionally needs the program and RPC setup described above.

The public RPC setting points to the website relay. The disabled canvas does not contact it. The setup page performs explicit connection checks. No private key, seed phrase, or Helius API key is stored in the repository.

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

## Deployment checks

`npm run test:deployment` checks recovery, v0 wallet signatures, paced RPC requests, image authorization, and the RPC and image Worker handlers using mocked network and storage responses. `npm run test:deployment:local` runs the compiled program through real loader upload and marketplace transactions on an isolated local validator (set `SOLANA_TEST_VALIDATOR` to its executable). The local test creates temporary test keys, never changes the released ELF, and blocks public network calls. It does not spend real SOL or prove a production wallet extension works.
