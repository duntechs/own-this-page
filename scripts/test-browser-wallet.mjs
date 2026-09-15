import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import {createHash, createPrivateKey, sign} from 'node:crypto';
import {build} from 'vite';
import {ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const payer = Keypair.generate();
const fixedOwner = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';
const privateKey = createPrivateKey({key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(payer.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8'});
const virtualEntry = path.join(root, '.sites-runtime/browser-wallet-regression.ts');
const entry = `
  export {Buffer as BrowserBuffer} from 'buffer';
  export {connectSolanaWallet, createVersionedSolanaDeploymentSigner, signSolanaImageUpload} from ${JSON.stringify(path.join(root, 'lib/solana-wallet.ts'))};
  export {DeploymentEngine} from ${JSON.stringify(path.join(root, 'lib/solana-deploy.ts'))};
  export {validateSolanaTransactionCompatibility} from ${JSON.stringify(path.join(root, 'lib/solana-transaction-compatibility.ts'))};
  import {PublicKey, SystemProgram, TransactionMessage, VersionedTransaction} from '@solana/web3.js';
  export function unsignedTransaction(payer, destination, blockhash) {
    const fromPubkey = new PublicKey(payer), toPubkey = new PublicKey(destination);
    return new VersionedTransaction(new TransactionMessage({payerKey: fromPubkey, recentBlockhash: blockhash, instructions: [SystemProgram.transfer({fromPubkey, toPubkey, lamports: 1})]}).compileToV0Message());
  }
`;

const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
// Synthetic valid assertions reproduce the user's observed shape: one extra
// readonly program, three added instructions, and 121 extra message bytes.
// These are test fixtures, not a claim to possess the user's private packet.
function guardedTransaction(input, mode = 'guarded') {
  const decoded = TransactionMessage.decompile(input.message);
  const target = [{pubkey: payer.publicKey, isSigner: false, isWritable: false}];
  const clock = new TransactionInstruction({programId: lighthouse, keys: [], data: Buffer.from([15, 0, 0, ...new Uint8Array(8), 4])});
  const balance = new TransactionInstruction({programId: lighthouse, keys: target, data: Buffer.from([5, 0, 0, ...new Uint8Array(8), 4])});
  const multi = new TransactionInstruction({programId: lighthouse, keys: target, data: Buffer.from([
    6, 0, 4, 8, ...createHash('sha256').update(Buffer.alloc(0)).digest(), 0, 0,
    1, ...new Uint8Array(8), 0, 5, 1, 0, 7, 0, 0,
  ])});
  if (mode === 'guarded-unknown-program') clock.programId = Keypair.generate().publicKey;
  if (mode === 'guarded-memory') balance.data[0] = 0;
  if (mode === 'guarded-cpi-logging') balance.data[1] = 3;
  if (mode === 'guarded-trailing-data') balance.data = Buffer.concat([balance.data, Buffer.from([0])]);
  if (mode === 'guarded-malformed-vector') multi.data[2] = 0;
  if (mode === 'guarded-invalid-enum') balance.data[balance.data.length - 1] = 8;
  if (mode === 'guarded-compute-change') decoded.instructions[1].data = ComputeBudgetProgram.setComputeUnitPrice({microLamports: 10001}).data;
  if (mode === 'guarded-payment-change') decoded.instructions[2].data[decoded.instructions[2].data.length - 1] ^= 1;
  if (mode === 'guarded-loader-change') decoded.instructions[3].data[0] ^= 1;
  if (mode === 'guarded-privilege-change') balance.keys = [...target, {pubkey: decoded.instructions[3].programId, isSigner: false, isWritable: true}];
  if (mode === 'guarded-blockhash-change') decoded.recentBlockhash = Keypair.generate().publicKey.toBase58();
  decoded.instructions.splice(2, 0, clock);
  decoded.instructions.push(balance, multi);
  if (mode === 'guarded-too-many') decoded.instructions.push(...Array.from({length: 6}, () => clock));
  return new VersionedTransaction(input.version === 'legacy' ? decoded.compileToLegacyMessage() : decoded.compileToV0Message());
}

async function browserBundle(oldComparisons = false) {
  const outDir = path.join(root, '.sites-runtime/browser-wallet-tests', oldComparisons ? 'old' : 'current');
  let transformedOldSource = false;
  await build({
    configFile: false, root, publicDir: false, logLevel: 'silent',
    plugins: [{name: 'browser-wallet-fixture', enforce: 'pre',
      resolveId(id) {if (id === virtualEntry) return '\0' + virtualEntry;},
      load(id) {if (id === '\0' + virtualEntry) return entry;},
      transform(code, id) {
        // Generated identity only in this isolated bundle. The production
        // owner and immutable program binary are never changed.
        if (id.endsWith('/lib/solana-client.ts')) return code.replaceAll(fixedOwner, payer.publicKey.toBase58());
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
  const fixture = {signingCalls: 0, version: '1.0.0', name: 'Isolated browser test wallet', icon: 'data:image/png;base64,', accounts: [account], chains: ['solana:mainnet'], features: {
    'standard:connect': {connect: async () => ({accounts: fixture.accounts})},
    'standard:events': {on: () => () => {}},
    'solana:signTransaction': {supportedTransactionVersions: ['legacy', 0], async signTransaction(...inputs) {
      fixture.signingCalls++;
      return inputs.map(input => {
        let tx = VersionedTransaction.deserialize(input.transaction);
        if (mode?.startsWith('guarded')) tx = guardedTransaction(tx, mode);
        if (mode === 'v1-conversion') {
          // The installed SDK reads v1 but intentionally cannot serialize it.
          // Encode the documented wire layout only to test diagnostic handling
          // of that unsupported output; it must never become acceptable input.
          const m = tx.message, h = m.header, instructions = m.compiledInstructions;
          const message = Buffer.concat([
            Buffer.from([0x81, h.numRequiredSignatures, h.numReadonlySignedAccounts, h.numReadonlyUnsignedAccounts, 0, 0, 0, 0]),
            new PublicKey(m.recentBlockhash).toBuffer(), Buffer.from([instructions.length, m.staticAccountKeys.length]),
            ...m.staticAccountKeys.map(key => key.toBuffer()),
            ...instructions.map(ix => Buffer.from([ix.programIdIndex, ix.accountKeyIndexes.length, ix.data.length & 255, ix.data.length >> 8])),
            ...instructions.map(ix => Buffer.concat([Buffer.from(ix.accountKeyIndexes), Buffer.from(ix.data)])),
          ]);
          return {signedTransaction: Uint8Array.from(Buffer.concat([message, sign(null, message, privateKey)]))};
        }
        if (mode === 'changed-transaction') tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
        if (mode === 'legacy-conversion') tx = new VersionedTransaction(TransactionMessage.decompile(tx.message).compileToLegacyMessage());
        if (mode === 'changed-priority') tx.message.compiledInstructions[1].data = ComputeBudgetProgram.setComputeUnitPrice({microLamports: 24000}).data;
        if (mode === 'changed-limit') tx.message.compiledInstructions[0].data = ComputeBudgetProgram.setComputeUnitLimit({units: 300000}).data;
        if (mode === 'changed-instruction') tx.message.compiledInstructions[2].data[tx.message.compiledInstructions[2].data.length - 1] ^= 1;
        if (mode === 'changed-account-order') {
          const keys = tx.message.staticAccountKeys;
          [keys[keys.length - 1], keys[keys.length - 2]] = [keys[keys.length - 2], keys[keys.length - 1]];
        }
        if (mode === 'extra-signer') {
          tx.message.header.numRequiredSignatures = 2;
          tx.signatures = [new Uint8Array(64), new Uint8Array(64)];
        }
        tx.sign([payer]);
        if (mode === 'invalid-transaction-signature' || mode === 'guarded-invalid-signature') tx.signatures[0][0] ^= 1;
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

// Capture the actual first transaction created by the browser deployment
// engine. Mock only its RPC state and intercept BEFORE signing or sending.
// This exercises seeded-account construction and SDK browser serialization,
// rather than recreating the implementation in a test-only transaction.
async function firstDeploymentTransaction(api) {
  const saved = new Map();
  const stop = Error('Captured without signing');
  let captured;
  const connection = {
    async getGenesisHash() {return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';},
    async getAccountInfoAndContext() {return {context: {slot: 100}, value: null};},
    async getMinimumBalanceForRentExemption(size) {return size * 8 + 1000;},
    async getLatestBlockhash() {return {blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 260};},
    async getFeeForMessage() {return {context: {slot: 100}, value: 5000};},
    async getBalance() {return 100_000_000_000;},
    async getRecentPrioritizationFees() {return [{prioritizationFee: 10000}];},
    async simulateTransaction() {return {context: {slot: 100}, value: {err: null}};},
    async sendRawTransaction() {assert.fail('The browser fixture must never broadcast');},
  };
  const engine = new api.DeploymentEngine({connection,
    binary: Uint8Array.from(await readFile(path.join(root, 'solana-market/artifacts/slot_market.so'))),
    storage: {getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value)},
  });
  const estimate = await engine.estimate();
  await assert.rejects(engine.run({publicKey: payer.publicKey, assertCurrentAccount() {}, async signTransactions(input) {
    assert.equal(input.length, 1); captured = input[0]; throw stop;
  }}, estimate.requiredLamports), error => error === stop);
  assert(captured, 'The real browser engine must reach the first wallet approval');
  const decoded = TransactionMessage.decompile(captured.message);
  assert.equal(decoded.instructions.length, 4);
  assert.equal(decoded.instructions[0].programId.toBase58(), ComputeBudgetProgram.programId.toBase58());
  assert.equal(decoded.instructions[3].programId.toBase58(), 'BPFLoaderUpgradeab1e11111111111111111111111');
  assert.equal(JSON.parse([...saved.values()][0]).pending.length, 0);
  return captured;
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
    await assert.rejects(signer.signTransactions(transactions(current)), /changed the deployment transaction|different transaction|valid deployment signature/);
  }
});
await check('fixed browser bundle accepts the exact image authorization and verifies its signature', async () => {
  const signature = await current.signSolanaImageUpload(await current.connectSolanaWallet(wallet()), imageMessage);
  assert.deepEqual(Uint8Array.from(signature), Uint8Array.from(sign(null, imageMessage, privateKey)));
});
await check('fixed browser bundle still rejects changed image authorization and invalid signatures', async () => {
  for (const mode of ['changed-image', 'invalid-image-signature']) await assert.rejects(current.signSolanaImageUpload(await current.connectSolanaWallet(wallet(mode)), imageMessage), /changed the image upload authorization|signature is invalid/);
});
const first = await firstDeploymentTransaction(current);
await check('actual browser-engine seeded upload-account transaction survives exact wallet signing', async () => {
  const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(wallet()));
  const [signed] = await signer.signTransactions([first]);
  assert.deepEqual(Uint8Array.from(signed.message.serialize()), Uint8Array.from(first.message.serialize()));
  assert(first.signatures[0].every(byte => byte === 0));
});
await check('browser signer accepts and preserves three valid assertions with the reported 121-byte growth', async () => {
  const fixture = wallet('guarded');
  const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(fixture));
  const [signed] = await signer.signTransactions([first]);
  const expectedGuarded = guardedTransaction(VersionedTransaction.deserialize(first.serialize()));
  assert.equal(signed.message.staticAccountKeys.length - first.message.staticAccountKeys.length, 1);
  assert.equal(signed.message.compiledInstructions.length, 7);
  assert.equal(signed.message.serialize().length - first.message.serialize().length, 121);
  assert.deepEqual(Uint8Array.from(signed.message.serialize()), Uint8Array.from(expectedGuarded.message.serialize()), 'No assertion may be stripped or rewritten');
  assert.equal(signed.message.recentBlockhash, first.message.recentBlockhash);
  assert(signed.serialize().length <= 1232);
  assert.equal(fixture.signingCalls, 1);
  assert(first.signatures[0].every(byte => byte === 0));
});
await check('browser guard acceptance still rejects altered payments, authority, fees, privileges and unknown assertion operations', async () => {
  for (const mode of ['guarded-unknown-program', 'guarded-memory', 'guarded-cpi-logging', 'guarded-trailing-data', 'guarded-malformed-vector', 'guarded-invalid-enum', 'guarded-compute-change', 'guarded-payment-change', 'guarded-loader-change', 'guarded-privilege-change', 'guarded-blockhash-change', 'guarded-too-many', 'guarded-invalid-signature']) {
    const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(wallet(mode)));
    await assert.rejects(signer.signTransactions([first]), error => {
      if (mode === 'guarded-invalid-signature') return /valid deployment signature/.test(error.message);
      assert.equal(error.name, 'SolanaWalletCompatibilityError', mode);
      assert(error.report.instructions.some(item => item.returnedProgram === lighthouse.toBase58()));
      if (mode === 'guarded-memory') assert(error.report.instructions.some(item => item.returnedProgram === lighthouse.toBase58() && item.returnedDiscriminator === 0));
      return true;
    });
  }
});
await check('actual deployment transaction changes are rejected with a shareable report and no signed packets', async () => {
  for (const mode of ['changed-transaction', 'legacy-conversion', 'v1-conversion', 'changed-priority', 'changed-limit', 'changed-instruction', 'changed-account-order', 'extra-signer']) {
    const signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(wallet(mode)));
    await assert.rejects(signer.signTransactions([first]), error => {
      assert.equal(error.name, 'SolanaWalletCompatibilityError', mode);
      assert.equal(error.report.diagnosticVersion, 'otp-wallet-1');
      const detail = error.report;
      assert.equal(detail.expected.version, 0); assert.equal(detail.matches.message, false);
      assert.equal(detail.expected.signatureCount, 1);
      assert.equal(detail.expected.instructionCount, 4);
      if (mode === 'changed-transaction') {assert.equal(detail.matches.blockhash, false); assert.equal(detail.matches.instructions, true);}
      if (mode === 'legacy-conversion') {assert.equal(detail.returned.version, 'legacy'); assert.equal(detail.matches.instructions, true);}
      if (mode === 'v1-conversion') assert.equal(detail.returned.version, 1);
      if (mode === 'changed-priority') {assert.equal(detail.instructions[1].dataEqual, false); assert.equal(detail.instructions[1].returnedCompute.priceMicroLamports, '24000');}
      if (mode === 'changed-limit') {assert.equal(detail.instructions[0].dataEqual, false); assert.equal(detail.instructions[0].returnedCompute.limit, 300000);}
      if (mode === 'changed-instruction') {assert.equal(detail.instructions[2].dataEqual, false); assert.equal(detail.matches.blockhash, true);}
      if (mode === 'changed-account-order') assert.equal(detail.matches.accountOrder, false);
      if (mode === 'extra-signer') {assert.equal(detail.returned.signatureCount, 2); assert.equal(detail.matches.header, false);}
      const report = JSON.stringify(error.report);
      for (const secret of [payer.publicKey.toBase58(), Buffer.from(first.serialize()).toString('base64'), first.message.recentBlockhash]) {
        assert(!report.includes(secret), 'Report must contain comparisons, not wallet addresses or transaction bytes');
      }
      assert(!/signedTransaction|privateKey|secretKey|api-key/.test(report));
      return true;
    });
  }
});
await check('local encoding inconsistency stops before a wallet prompt', async () => {
  const fixture = wallet(), signer = current.createVersionedSolanaDeploymentSigner(await current.connectSolanaWallet(fixture));
  const input = transactions(current)[0], changed = VersionedTransaction.deserialize(input.serialize());
  changed.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  input.serialize = () => Uint8Array.from(changed.serialize());
  await assert.rejects(signer.signTransactions([input]), /encoded consistently/);
  assert.equal(fixture.signingCalls, 0);
});
console.log(`Browser wallet regression: ${passed} checks passed using Vite's browser bundle and strict Buffer polyfill. No live wallet or network used.`);
