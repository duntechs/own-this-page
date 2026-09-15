import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {Keypair, TransactionMessage, VersionedTransaction, SystemProgram} from '@solana/web3.js';
import {createPrivateKey, sign} from 'node:crypto';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.sites-runtime/deployment-wallet-tests');
await build({configFile: false, root, publicDir: false, logLevel: 'silent', build: {ssr: true, outDir: out, emptyOutDir: true, rollupOptions: {input: {wallet: path.join(root, 'lib/solana-wallet.ts'), image: path.join(root, 'lib/solana-image-upload.ts')}, output: {entryFileNames: '[name].mjs'}}}});
const {connectSolanaWallet, createVersionedSolanaDeploymentSigner, signSolanaImageUpload} = await import(pathToFileURL(path.join(out, 'wallet.mjs')));
const {placementImageType, MAX_PLACEMENT_IMAGE_BYTES} = await import(pathToFileURL(path.join(out, 'image.mjs')));
const payer = Keypair.generate();
const messageKey = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(payer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8'});
function tx() {
  return new VersionedTransaction(new TransactionMessage({payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1})]}).compileToV0Message());
}
function fake(mode) {
  const account = {address: payer.publicKey.toBase58(), publicKey: payer.publicKey.toBytes(), chains: ['solana:mainnet'], features: ['solana:signTransaction']};
  const wallet = {version: '1.0.0', name: 'Local test wallet', icon: 'data:image/png;base64,', accounts: [account], chains: ['solana:mainnet'], features: {
    'standard:connect': {connect: async () => ({accounts: wallet.accounts})},
    'standard:events': {on: () => () => {}},
    'solana:signTransaction': {supportedTransactionVersions: mode === 'legacy-only' ? ['legacy'] : ['legacy', 0], async signTransaction(...inputs) {
      const outputs = inputs.map(input => {
        assert.equal(input.chain, 'solana:mainnet');
        const signed = VersionedTransaction.deserialize(input.transaction);
        if (mode === 'changed-message') signed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        if (mode !== 'missing-signature') signed.sign([payer]);
        if (mode === 'invalid-signature') signed.signatures[0][10] ^= 1;
        return {signedTransaction: signed.serialize()};
      });
      if (mode === 'wallet-change') wallet.accounts = [];
      if (mode === 'reverse') outputs.reverse();
      if (mode === 'incomplete') outputs.pop();
      return outputs;
    }},
  }};
  return wallet;
}
let count = 0;
async function check(name, run) {await run(); console.log(`PASS ${++count} ${name}`);}
await check('v0 messages survive exact wallet round trip and all five signatures verify', async () => {
  const signer = createVersionedSolanaDeploymentSigner(await connectSolanaWallet(fake()));
  const inputs = Array.from({length: 5}, tx);
  const messages = inputs.map(t => Buffer.from(t.message.serialize()));
  const signed = await signer.signTransactions(inputs);
  assert.equal(signed.length, 5);
  signed.forEach((t, i) => assert.deepEqual(Buffer.from(t.message.serialize()), messages[i]));
  inputs.forEach(t => assert(t.signatures[0].every(byte => byte === 0)));
});
for (const mode of ['changed-message', 'missing-signature', 'invalid-signature', 'wallet-change', 'reverse', 'incomplete', 'legacy-only']) {
  await check(`rejects ${mode} before a broadcast can happen`, async () => {
    const signer = createVersionedSolanaDeploymentSigner(await connectSolanaWallet(fake(mode)));
    await assert.rejects(signer.signTransactions([tx(), tx()]));
  });
}
await check('rejects oversized batch and an already signed input', async () => {
  const signer = createVersionedSolanaDeploymentSigner(await connectSolanaWallet(fake()));
  await assert.rejects(signer.signTransactions(Array.from({length: 6}, tx)));
  const signed = tx(); signed.sign([payer]);
  await assert.rejects(signer.signTransactions([signed]));
});
function imageWallet(mode) {
  const wallet = fake();
  if (mode !== 'missing-account-feature') wallet.accounts[0].features.push('solana:signMessage');
  wallet.imageCalls = 0;
  if (mode !== 'missing-wallet-feature') wallet.features['solana:signMessage'] = {async signMessage(...inputs) {
    wallet.imageCalls++;
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].account.address, payer.publicKey.toBase58());
    if (mode === 'changed-message') inputs[0].message[0] ^= 1;
    const signedMessage = Uint8Array.from(inputs[0].message);
    const signature = Uint8Array.from(sign(null, signedMessage, messageKey));
    if (mode === 'invalid-signature') signature[0] ^= 1;
    if (mode === 'wallet-change') wallet.accounts = [];
    wallet.lastSignature = signature;
    if (mode === 'empty-result') return [];
    if (mode === 'short-signature') return [{signedMessage, signature: signature.subarray(0, 63)}];
    if (mode === 'extra-result') return [{signedMessage, signature}, {signedMessage, signature}];
    return [{signedMessage, signature}];
  }};
  return wallet;
}
const uploadMessage = () => new TextEncoder().encode(`Own This Page image upload\nOrigin: https://ownpage.example\nWallet: ${payer.publicKey.toBase58()}\nSHA-256: ${'a'.repeat(64)}\nTime: 1800000000`);
await check('image authorization returns a verified detached signature without mutating the message', async () => {
  const wallet = imageWallet(), message = uploadMessage(), snapshot = Uint8Array.from(message);
  const signature = await signSolanaImageUpload(await connectSolanaWallet(wallet), message);
  assert.deepEqual(message, snapshot); assert.equal(wallet.imageCalls, 1);
  assert.deepEqual(signature, Uint8Array.from(sign(null, snapshot, messageKey)));
  wallet.lastSignature.fill(0); assert(signature.some(byte => byte !== 0), 'Returned signature must not alias wallet-owned output memory');
});
for (const mode of ['changed-message', 'invalid-signature', 'short-signature', 'wallet-change', 'empty-result', 'extra-result', 'missing-wallet-feature', 'missing-account-feature']) {
  await check(`image authorization rejects ${mode}`, async () => {
    const wallet = imageWallet(mode), message = uploadMessage(), snapshot = Uint8Array.from(message);
    await assert.rejects(signSolanaImageUpload(await connectSolanaWallet(wallet), message), /authorization|signature|account changed|support image/);
    assert.deepEqual(message, snapshot, 'A wallet must not be allowed to mutate the caller message');
    if (mode.startsWith('missing-')) assert.equal(wallet.imageCalls, 0);
  });
}
await check('image authorization rejects an account switch during asynchronous signature verification', async () => {
  const wallet = imageWallet(), session = await connectSolanaWallet(wallet);
  const verify = crypto.subtle.verify;
  crypto.subtle.verify = async function(...args) {const valid = await verify.apply(this, args); wallet.accounts = []; return valid;};
  try {await assert.rejects(signSolanaImageUpload(session, uploadMessage()), /account changed|disconnected/);}
  finally {crypto.subtle.verify = verify;}
});
await check('image magic checks allow PNG, JPEG and WebP while rejecting active content, truncation and excessive size', async () => {
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const jpeg = Uint8Array.from([255,216,255,224,0,16,74,70,73,70,0,1]);
  const webp = Uint8Array.from([82,73,70,70,4,0,0,0,87,69,66,80]);
  assert.equal(placementImageType(png), 'image/png');
  assert.equal(placementImageType(jpeg), 'image/jpeg');
  assert.equal(placementImageType(webp), 'image/webp');
  for (const invalid of [png.subarray(0, 8), Uint8Array.from([255,216,255]), new TextEncoder().encode('<svg onload="alert(1)"/>'), new TextEncoder().encode('<html><script>alert(1)</script></html>'), new Uint8Array(MAX_PLACEMENT_IMAGE_BYTES + 1)]) assert.throws(() => placementImageType(invalid), /image|PNG|JPG|WebP/);
});
console.log(`Deployment wallet and image authorization: ${count} checks passed; no live wallet or network used.`);
