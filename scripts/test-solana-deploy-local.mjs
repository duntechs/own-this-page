// Optional integration test: SOLANA_TEST_VALIDATOR=/path/to/solana-test-validator
// node scripts/test-solana-deploy-local.mjs
// Runs a new, isolated local ledger. Never connects to devnet or mainnet.
// Only the temporary JavaScript bundle's authorized deployer/network are changed;
// the approved ELF and its immutable project treasury remain byte-for-byte intact.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {Connection, Keypair, PublicKey, SystemInstruction, SystemProgram, Transaction, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const executable = process.env.SOLANA_TEST_VALIDATOR || 'solana-test-validator';
const artifactPath = path.join(root, 'solana-market/artifacts/slot_market.so');
const artifact = await readFile(artifactPath);
const manifest = JSON.parse(await readFile(path.join(root, 'solana-market/artifacts/build-manifest.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(artifact.length, manifest.programLength);
assert.equal(hash(artifact), manifest.programSha256);
const actualTreasury = manifest.treasury;
const deployer = Keypair.generate();
const genesisMint = Keypair.generate().publicKey;
const buyer = Keypair.generate();
const successor = Keypair.generate();
const ledgerRoot = await mkdtemp(path.join(os.tmpdir(), 'own-page-validator-'));
const bundleRoot = path.join(root, '.sites-runtime', `deployment-local-${randomUUID()}`);
await mkdir(bundleRoot, {recursive: true});
const originalFetch = globalThis.fetch;
let validator;
let validatorOutput = '';
let passed = 0;
const check = message => {passed++; console.log(`PASS ${message}`);};

async function availablePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const servers = [];
    try {
      const first = net.createServer(); servers.push(first);
      first.listen(0, '127.0.0.1'); await once(first, 'listening');
      const port = first.address().port;
      if (port > 65532) continue;
      for (const offset of [1, 2]) {
        const next = net.createServer(); servers.push(next);
        next.listen(port + offset, '127.0.0.1'); await once(next, 'listening');
      }
      return port;
    } catch {
      // Find another adjacent RPC, pubsub, and faucet port range.
    } finally {
      for (const server of servers) if (server.listening) await new Promise(resolve => server.close(resolve));
    }
  }
  throw Error('No free local validator port range.');
}

async function confirmed(connection, signature) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const result = (await connection.getSignatureStatuses([signature], {searchTransactionHistory: true})).value[0];
    if (result?.err) throw Error(`Local transaction failed: ${JSON.stringify(result.err)}`);
    if (result?.confirmationStatus === 'confirmed' || result?.confirmationStatus === 'finalized') return result;
    await wait(100);
  }
  throw Error('Local transaction confirmation exceeded 30 seconds.');
}

async function bundle(entry, name, genesis, replaceAuthority) {
  const outfile = path.join(bundleRoot, `${name}.mjs`);
  await build({
    entryPoints: [path.join(root, entry)], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22',
    packages: 'external', logLevel: 'silent',
    plugins: [{name: 'isolated-validator-fixture', setup(context) {
      context.onLoad({filter: /\.(ts|json)$/}, async ({path: filename}) => {
        let contents = await readFile(filename, 'utf8');
        // No production source, artifact, or saved public configuration is edited.
        contents = contents.replaceAll('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', genesis);
        if (replaceAuthority) contents = contents.replaceAll(actualTreasury, deployer.publicKey.toBase58());
        return {contents, loader: filename.endsWith('.json') ? 'json' : 'ts'};
      });
    }}],
  });
  return import(pathToFileURL(outfile).href);
}

try {
  const rpcPort = await availablePort();
  const rpc = `http://127.0.0.1:${rpcPort}`;
  globalThis.fetch = (input, options) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(url.origin, rpc, 'This test must never access a public network.');
    return originalFetch(input, {...options, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(options?.signal ? [options.signal] : [])])});
  };
  validator = spawn(executable, [
    '--ledger', path.join(ledgerRoot, 'ledger'), '--bind-address', '127.0.0.1', '--gossip-host', '127.0.0.1',
    '--rpc-port', String(rpcPort), '--faucet-port', String(rpcPort + 2), '--mint', genesisMint.toBase58(),
    '--url', rpc, '--quiet',
  ], {stdio: ['ignore', 'pipe', 'pipe']});
  let startupError;
  validator.on('error', error => {startupError = error;});
  for (const stream of [validator.stdout, validator.stderr]) stream.on('data', bytes => {validatorOutput = (validatorOutput + bytes).slice(-12_000);});
  const connection = new Connection(rpc, {commitment: 'confirmed', disableRetryOnRateLimit: true});
  let genesis;
  const startupDeadline = Date.now() + 40_000;
  while (Date.now() < startupDeadline) {
    if (startupError) throw startupError;
    if (validator.exitCode !== null) throw Error(`Validator exited: ${validatorOutput}`);
    try {genesis = await connection.getGenesisHash(); break;} catch {await wait(300);}
  }
  assert.ok(genesis, `Validator did not start: ${validatorOutput}`);
  // Genesis exposes RPC before the first bank has populated slot-hash sysvars.
  while (await connection.getSlot('confirmed') < 3) {
    assert.ok(Date.now() < startupDeadline, 'Validator did not produce its first confirmed banks.');
    await wait(200);
  }
  await confirmed(connection, await connection.requestAirdrop(deployer.publicKey, 20_000_000_000));
  check('isolated validator starts with a new local ledger');

  const [{DeploymentEngine, DeploymentPausedError}, client] = await Promise.all([
    bundle('lib/solana-deploy.ts', 'deploy', genesis, true),
    bundle('lib/solana-client.ts', 'client', genesis, false),
  ]);
  assert.equal(client.SOLANA_TREASURY, actualTreasury, 'Marketplace actions must retain the real immutable project treasury.');
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  let signaturesApproved = 0;
  const signer = {
    publicKey: deployer.publicKey,
    assertCurrentAccount() {},
    async signTransactions(transactions) {
      signaturesApproved += transactions.length;
      return transactions.map(transaction => {
        const signed = VersionedTransaction.deserialize(transaction.serialize());
        signed.sign([deployer]);
        return signed;
      });
    },
  };
  const transmissions = [];
  const actualSend = connection.sendRawTransaction.bind(connection);
  let loseFirstResponse = true;
  connection.sendRawTransaction = async (bytes, options) => {
    if (loseFirstResponse) assert.ok([...values.values()].some(value => JSON.parse(value).pending?.some(receipt => receipt.raw === Buffer.from(bytes).toString('base64'))), 'The first signed receipt must be saved before broadcasting.');
    const signature = await actualSend(bytes, options);
    transmissions.push({signature, bytes: Buffer.from(bytes)});
    if (loseFirstResponse) {
      loseFirstResponse = false;
      // The validator accepted this transaction, but its HTTP response was lost.
      throw Error('TEST: connection lost after accepted broadcast');
    }
    return signature;
  };
  let didPause = false;
  let engine = new DeploymentEngine({connection, binary: artifact, cluster: 'devnet', storage, onUpdate(progress) {
    if (!didPause && progress.writtenBytes > 0 && progress.writtenBytes < artifact.length) {
      didPause = true;
      engine.pause();
    }
  }});
  const estimate = await engine.estimate();
  assert.ok(estimate.requiredLamports > 0);
  assert.ok(estimate.remainingTransactions > 1);
  await assert.rejects(() => engine.run(signer, estimate.requiredLamports), DeploymentPausedError);
  assert.equal(loseFirstResponse, false);
  assert.equal(didPause, true);
  const paused = await engine.inspect();
  assert.ok(paused.writtenBytes > 0 && paused.writtenBytes < artifact.length);
  assert.ok(paused.bufferId && paused.programId);
  const originalBuffer = paused.bufferId;
  const originalProgram = paused.programId;
  const savedJson = [...values.values()].join('');
  assert.ok(savedJson.includes(originalBuffer));
  assert.ok(!savedJson.includes(Buffer.from(deployer.secretKey).toString('base64')), 'Recovery storage must not contain wallet secrets.');
  check('lost broadcast response reconciles and upload pauses after confirmed work');

  // Simulate closing and reopening the browser: new engine, copied storage, same account.
  const restoredValues = new Map(values);
  const restoredStorage = {getItem: key => restoredValues.get(key) ?? null, setItem: (key, value) => restoredValues.set(key, value), removeItem: key => restoredValues.delete(key)};
  engine = new DeploymentEngine({connection, binary: artifact, cluster: 'devnet', storage: restoredStorage});
  const resumed = await engine.inspect();
  assert.equal(resumed.bufferId, originalBuffer);
  assert.equal(resumed.programId, originalProgram);
  assert.equal(resumed.writtenBytes, paused.writtenBytes);
  const remainingEstimate = await engine.estimate();
  assert.ok(remainingEstimate.remainingTransactions < estimate.remainingTransactions);
  const result = await engine.run(signer, remainingEstimate.requiredLamports);
  assert.equal(result.programId, originalProgram);
  assert.equal(result.programSha256, manifest.programSha256);
  assert.equal(result.programLength, artifact.length);
  assert.equal((await engine.verify(result.programId)).programId, result.programId);
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programId = new PublicKey(result.programId);
  const program = await connection.getAccountInfo(programId, 'confirmed');
  assert.ok(program.executable && program.owner.equals(loader));
  const programData = await connection.getAccountInfo(new PublicKey(program.data.subarray(4, 36)), 'confirmed');
  assert.equal(programData.data.readUInt32LE(0), 3);
  assert.equal(new PublicKey(programData.data.subarray(13, 45)).toBase58(), deployer.publicKey.toBase58());
  assert.deepEqual(programData.data.subarray(45, 45 + artifact.length), artifact);
  assert.ok(programData.data.subarray(45 + artifact.length).every(byte => byte === 0));
  check('fresh engine resumes the same buffer and real loader deploys the exact approved ELF');

  // Duplicates may only resend the identical signed packet, never create a new buffer.
  const uniqueTransmissions = new Map(transmissions.map(item => [item.signature, item.bytes]));
  for (const packet of transmissions) assert.deepEqual(packet.bytes, uniqueTransmissions.get(packet.signature));
  const creations = [...uniqueTransmissions.values()].flatMap(bytes => TransactionMessage.decompile(VersionedTransaction.deserialize(bytes).message).instructions)
    .filter(instruction => instruction.programId.equals(SystemProgram.programId) && SystemInstruction.decodeInstructionType(instruction) === 'CreateWithSeed')
    .map(instruction => SystemInstruction.decodeCreateWithSeed(instruction).newAccountPubkey.toBase58());
  assert.deepEqual(creations.sort(), [originalBuffer, originalProgram].sort(), 'One buffer and one program are created across all resumes.');
  assert.ok(signaturesApproved >= uniqueTransmissions.size);
  assert.equal((await engine.inspect()).stage, 'verified');
  const signaturesBeforeVerifiedRun = signaturesApproved;
  assert.equal((await engine.run(signer, remainingEstimate.requiredLamports)).programId, result.programId);
  assert.equal(signaturesApproved, signaturesBeforeVerifiedRun, 'Verified deployments must not be paid for twice.');
  check('completed deployment is idempotent and does not request another wallet signature');

  async function send(instructions, keypair) {
    const recent = await connection.getLatestBlockhash('confirmed');
    const transaction = new Transaction({feePayer: keypair.publicKey, ...recent}).add(...instructions);
    transaction.sign(keypair);
    const signature = await actualSend(transaction.serialize(), {skipPreflight: false, preflightCommitment: 'confirmed'});
    await confirmed(connection, signature);
    return signature;
  }
  await send([buyer, successor].map(wallet => SystemProgram.transfer({fromPubkey: deployer.publicKey, toPubkey: wallet.publicKey, lamports: 3_000_000_000})), deployer);
  const treasury = new PublicKey(actualTreasury);
  const market = {programId, connection, config: {cluster: 'devnet', rpc, programId: result.programId, programSha256: manifest.programSha256, programLength: artifact.length}};
  const slotId = 18; // The catalog's 0.1 SOL starting-price tier.
  const readSlot = async () => (await client.readSolanaSlots(market, [slotId])).states[0];
  const balance = async address => BigInt(await connection.getBalance(address, 'confirmed'));
  const content = {text: 'Local validator purchase', image: 'https://example.com/image.png', link: 'https://example.com/'};
  const treasuryBefore = await balance(treasury);
  let state = await readSlot();
  const buy = client.buildSolanaInstruction(programId, {kind: 'buy', actor: buyer.publicKey.toBase58(), id: slotId, expected: state, content});
  assert.equal(buy.paymentLamports, 100_000_000n);
  await send([buy.instruction], buyer);
  state = await readSlot();
  assert.equal(state.owner, buyer.publicKey.toBase58());
  assert.equal(state.paid, buy.paymentLamports);
  assert.equal(await balance(treasury) - treasuryBefore, buy.paymentLamports);
  check('actual 0.1 SOL slot purchase records ownership and pays the immutable treasury');

  const edited = {...content, text: 'Owner edited this slot'};
  await send([client.buildSolanaInstruction(programId, {kind: 'edit', actor: buyer.publicKey.toBase58(), id: slotId, expected: state, content: edited}).instruction], buyer);
  state = await readSlot();
  assert.equal(state.content.text, edited.text);
  assert.equal(state.version, 2n);
  assert.equal(await balance(treasury) - treasuryBefore, buy.paymentLamports);
  check('actual owner edit persists content without an extra purchase payment');

  const previousOwnerBalance = await balance(buyer.publicKey);
  const takeover = client.buildSolanaInstruction(programId, {kind: 'buy', actor: successor.publicKey.toBase58(), id: slotId, expected: state, content: {...content, text: 'New owner'}});
  assert.equal(takeover.paymentLamports, 200_000_000n);
  await send([takeover.instruction], successor);
  state = await readSlot();
  assert.equal(state.owner, successor.publicKey.toBase58());
  assert.equal(state.paid, 200_000_000n);
  assert.equal(state.version, 3n);
  assert.equal(await balance(treasury) - treasuryBefore, 300_000_000n);
  assert.equal(await balance(buyer.publicKey), previousOwnerBalance, 'Prior owners receive no takeover payout.');
  check('actual 2x takeover changes ownership, pays treasury, and gives prior owner no payout');
  console.log(`\n${passed} isolated local-validator deployment and marketplace checks passed. No public network or real SOL used.`);
} finally {
  globalThis.fetch = originalFetch;
  if (validator && validator.exitCode === null) {
    validator.kill('SIGTERM');
    await Promise.race([once(validator, 'exit'), wait(5_000)]);
    if (validator.exitCode === null && !validator.signalCode) validator.kill('SIGKILL');
  }
  assert.equal(hash(await readFile(artifactPath)), manifest.programSha256, 'The approved artifact must stay unchanged.');
  await rm(bundleRoot, {recursive: true, force: true});
  await rm(ledgerRoot, {recursive: true, force: true});
}
