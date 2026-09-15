import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {createPrivateKey, sign} from 'node:crypto';
import {build} from 'vite';
import {Keypair, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const payer = Keypair.generate();
const privateKey = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(payer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8'});
const virtualEntry = path.join(root, '.sites-runtime/browser-wallet-regression.ts');
const entry = `
  export {Buffer as BrowserBuffer} from 'buffer';
  export {connectSolanaWallet, createVersionedSolanaDeploymentSigner, signSolanaImageUpload} from ${JSON.stringify(path.join(root, 'lib/solana-wallet.ts'))};
  import {PublicKey, SystemProgram, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
  export function unsignedTransaction(payer, destination, blockhash) {
    const fromPubkey = new PublicKey(payer), toPubkey = new PublicKey(destination);
    return new VersionedTransaction(new TransactionMessage({payerKey: fromPubkey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({fromPubkey, toPubkey, lamports: 1})]}).compileToV0Message());
  }
`;

async function browserBundle(oldComparisons = false) {
  const outDir = path.join(root, '.sites-runtime/browser-wallet-tests', oldComparisons ? 'old' : 'current');
  let transformedOldSource = false;
  await build({
    configFile: false, root, publicDir: false, logLevel: 'silent',
    plugins: [{name: 'browser-wallet-fixture', enforce: 'pre',
      resolveId(id) {if (id === virtualEntry) return '\0' + virtualEntry;},
      load(id) {if (id === '\0' + virtualEntry) return entry;},
      transform(code, id) {
        if (!oldComparisons || !id.endsWith('/lib/solana-wallet.ts')) return;
        const old = code
          .replace('Buffer.from(transaction.message.serialize()).equals(Buffer.from(messages[index]))', 'Buffer.from(transaction.message.serialize()).equals(messages[index])')
          .replace('Buffer.from(output[0].signedMessage).equals(Buffer.from(expected))', 'Buffer.from(output[0].signedMessage).equals(expected)');
        assert(old.includes('Buffer.from(transaction.message.serialize()).equals(messages[index])'), 'Old versioned comparison fixture must match the production callsite');
        assert(old.includes('Buffer.from(output[0].signedMessage).equals(expected)'), 'Old image comparison fixture must match the production callsite');
        transformedOldSource = true;
        return old;
      },
    }],
    build: {target: 'es2022', outDir, emptyOutDir: true, minify: false, lib: {entry: virtualEntry, name: 'BrowserWalletRegression', formats: ['iife'], fileName: () => 'wallet.js'}},
  });
  if (oldComparisons) assert(transformedOldSource, 'The old-source fixture was not applied');
  const code = await readFile(path.join(outDir, 'wallet.js'), 'utf8');
  // Execute the real browser-target dependency graph without Node Buffer,
  // require, process, or network access. Exposing WebCrypto and typed arrays
  // supplies browser primitives, not Node's permissive Buffer.equals method.
  const context = vm.createContext({crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, setTimeout, clearTimeout, URL, AbortSignal, AbortController,
    fetch: () => {throw Error('Network access is forbidden in this browser regression.');}, console});
  vm.runInContext(code, context, {filename: `browser-wallet-${oldComparisons ? 'old' : 'current'}.js`, timeout: 10_000});
  assert.equal(vm.runInContext('typeof Buffer', context), 'undefined', 'Node Buffer must not be available to the browser bundle');
  const api = context.BrowserWalletRegression;
  assert(api?.BrowserBuffer, 'Browser buffer package must be bundled');
  assert.throws(() => api.BrowserBuffer.from([1]).equals(Uint8Array.from([1])), /Argument must be a Buffer/, 'This test must exercise the strict browser Buffer polyfill');
  return api;
}

function wallet(mode) {
  const account = {address: payer.publicKey.toBase58(), publicKey: payer.publicKey.toBytes(), chains: ['solana:mainnet'], features: ['solana:signTransaction', 'solana:signMessage']};
  const fixture = {version: '1.0.0', name: 'Isolated browser test wallet', icon: 'data:image/png;base64,', accounts: [account], chains: ['solana:mainnet'], features: {
    'standard:connect': {connect: async () => ({accounts: fixture.accounts})},
    'standard:events': {on: () => () => {}},
    'solana:signTransaction': {supportedTransactionVersions: ['legacy', 0], async signTransaction(...inputs) {
      return inputs.map(input => {
        const tx = VersionedTransaction.deserialize(input.transaction);
        if (mode === 'changed-transaction') tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        tx.sign([payer]);
        if (mode === 'invalid-transaction-signature') tx.signatures[0][0] ^= 1;
        return {signedTransaction: Uint8Array.from(tx.serialize())};
      });
    }},
    'solana:signMessage': {async signMessage(input) {
      const message = Uint8Array.from(input.message);
      if (mode === 'changed-image') message[0] ^= 1;
      const signature = Uint8Array.from(sign(null, message, privateKey));
      if (mode === 'invalid-image-signature') signature[0] ^= 1;
      return [{signedMessage: message, signature}];
    }},
  }};
  return fixture;
}
function transactions(api) {
  return Array.from({length: 5}, () => api.unsignedTransaction(payer.publicKey.toBase58(), Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()));
}
const imageMessage = new TextEncoder().encode(`Own This Page image upload\nOrigin: https://ownpage.example\nWallet: ${payer.publicKey.toBase58()}\nSHA-256: ${'a'.repeat(64)}\nTime: 1800000000`);
let passed = 0;
async function check(name, run) {await run(); console.log(`PASS ${++passed} ${name}`);}

const old = await browserBundle(true);
await check('old browser v0 wallet comparison reproduces Argument must be a Buffer', async () => {
  const signer = old.createVersionedSolanaDeploymentSigner(await old.connectSolanaWallet(wallet()));
  await assert.rejects(signer.signTransactions(transactions(old)), /Argument must be a Buffer/);
});
await check('old browser image authorization comparison reproduces Argument must be a Buffer', async () => {
  await assert.rejects(old.signSolanaImageUpload(await old.connectSolanaWallet(wallet()), imageMessage), /Argument must be a Buffer/);
});

const current = await browserBundle();
await check('fixed browser bundle accepts five exact versioned transactions and verifies all signatures', async () => {
  const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(wallet()));
  const input = transactions(current), snapshots = input.map(tx => Uint8Array.from(tx.message.serialize()));
  const output = await signer.signTransactions(input);
  assert.equal(output.length, 5);
  output.forEach((tx, i) => assert.deepEqual(Uint8Array.from(tx.message.serialize()), snapshots[i]));
  input.forEach(tx => assert(tx.signatures[0].every(byte => byte === 0), 'Wallet signing must not mutate the original transaction'));
});
await check('fixed browser bundle still rejects changed transaction messages and invalid signatures', async () => {
  for (const mode of ['changed-transaction', 'invalid-transaction-signature']) {
    const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(wallet(mode)));
    await assert.rejects(signer.signTransactions(transactions(current)), /changed the deployment transaction|valid deployment signature/);
  }
});
await check('fixed browser bundle accepts the exact image authorization and verifies its signature', async () => {
  const signature = await current.signSolanaImageUpload(await current.connectSolanaWallet(wallet()), imageMessage);
  assert.deepEqual(Uint8Array.from(signature), Uint8Array.from(sign(null, imageMessage, privateKey)));
});
await check('fixed browser bundle still rejects changed image authorization and invalid signatures', async () => {
  for (const mode of ['changed-image', 'invalid-image-signature']) await assert.rejects(current.signSolanaImageUpload(await current.connectSolanaWallet(wallet(mode)), imageMessage), /changed the image upload authorization|signature is invalid/);
});
console.log(`Browser wallet regression: ${passed} checks passed using Vite's browser bundle and strict Buffer polyfill. No live wallet or network used.`);
