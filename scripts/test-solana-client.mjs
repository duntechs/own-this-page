import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {ComputeBudgetProgram, ComputeBudgetInstruction, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.sites-runtime/solana-client-tests');
await build({configFile: false, root, logLevel: 'silent', build: {ssr: true, outDir: output, emptyOutDir: true, rollupOptions: {input: {client: path.join(root, 'lib/solana-client.ts'), wallet: path.join(root, 'lib/solana-wallet.ts'), receipt: path.join(root, 'lib/solana-receipt.ts')}, output: {entryFileNames: '[name].mjs'}}}});
const receiptApi = await import(pathToFileURL(path.join(output, 'receipt.mjs')).href);
const client = await import(pathToFileURL(path.join(output, 'client.mjs')).href);
const walletApi = await import(pathToFileURL(path.join(output, 'wallet.mjs')).href);
const {SOLANA_TREASURY, SOLANA_GENESIS, SLOT_ACCOUNT_SIZE, createMarketConnection, decodeSolanaSlot, emptySolanaSlot, slotPda, verifySolanaProgram, readSolanaSlots, buildSolanaInstruction, prepareSolanaAction, validateSlotContent, validSolanaContentUrl} = client;
const {connectSolanaWallet, onSolanaAccountChange, verifySignedSolanaTransaction, createSolanaDeploymentSigner, signAndSendSolanaTransaction, SolanaSubmissionError, encodeSolanaSignature} = walletApi;
const programId = Keypair.generate().publicKey;
const buyer = Keypair.generate();
const other = Keypair.generate();
assert.equal(SOLANA_TREASURY, '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9');
const treasury = new PublicKey(SOLANA_TREASURY);
const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const lighthouse = new PublicKey('L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95');
const walletAssertion = () => new TransactionInstruction({programId:lighthouse,keys:[{pubkey:buyer.publicKey,isSigner:false,isWritable:false}],data:Buffer.from([5,0,0,0,0,0,0,0,0,0,0,4])});
function addWalletAssertions(transaction) {
  transaction.instructions=[...transaction.instructions.slice(0,2),walletAssertion(),...transaction.instructions.slice(2),walletAssertion(),walletAssertion()];
}
const binary = Buffer.alloc(64, 42);
const programSha256 = createHash('sha256').update(binary).digest('hex');
const config = {cluster: 'mainnet-beta', rpc: 'https://rpc.example.com/', programId: programId.toBase58(), programSha256, programLength: binary.length};
const content = {text: 'Own this space', image: 'https://example.com/ad.png', link: 'https://example.com/'};
const basic = () => ({kind: 'buy', actor: buyer.publicKey.toBase58(), id: 0, expected: emptySolanaSlot(0), content});
function info(owner, data, executable = false) {return {owner, data, executable, lamports: 10_000_000, rentEpoch: 0};}
function programAccounts() {
  const dataKey = PublicKey.findProgramAddressSync([programId.toBuffer()], loader)[0];
  const program = Buffer.alloc(36); program.writeUInt32LE(2); dataKey.toBuffer().copy(program, 4);
  const data = Buffer.alloc(45 + binary.length + 64); data.writeUInt32LE(3); data[12] = 1; treasury.toBuffer().copy(data, 13); binary.copy(data, 45);
  return {dataKey, program: info(loader, program, true), data: info(loader, data)};
}
function mockMarket(overrides = {}) {
  const accounts = programAccounts();
  const market = createMarketConnection(config);
  market.connection = {
    async getGenesisHash() {return SOLANA_GENESIS['mainnet-beta'];},
    async getAccountInfoAndContext(key) {return {context: {slot: 100}, value: key.equals(programId) ? accounts.program : accounts.data};},
    async getMultipleAccountsInfoAndContext(keys) {return {context: {slot: 101}, value: keys.map(() => null)};},
    async getRecentPrioritizationFees() {return [{prioritizationFee: 10_000}];},
    async getLatestBlockhash() {return {blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200};},
    async getMinimumBalanceForRentExemption() {return 7_000_000;},
    async getFeeForMessage() {return {context: {slot: 101}, value: 7400};},
    async getBalance() {return 10_000_000_000;},
    async simulateTransaction() {return {context: {slot: 101}, value: {err: null}};},
    async getBlockHeight() {return 110;},
    ...overrides,
  };
  return {market, accounts};
}
function encodedSlot({id = 0, owner = buyer.publicKey, paid = 100_000_000n, version = 1n, locked = false, text = 'hello', image = '', link = ''} = {}) {
  const data = Buffer.alloc(SLOT_ACCOUNT_SIZE);
  data.write('SLOTMKT1'); data.writeUInt16LE(id, 8); owner.toBuffer().copy(data, 10); data.writeBigUInt64LE(paid, 42); data.writeBigUInt64LE(version, 50); data[58] = Number(locked);
  for (const [offset, value] of [[59, text], [341, image], [599, link]]) {const bytes = Buffer.from(value); data.writeUInt16LE(bytes.length, offset); bytes.copy(data, offset + 2);}
  return data;
}
function fakeWallet(signer = buyer, changeTransaction, {changeSignedTransaction, changeOutputs} = {}) {
  const account = {address: signer.publicKey.toBase58(), publicKey: Uint8Array.from(signer.publicKey.toBuffer()), chains: ['solana:mainnet'], features: ['solana:signTransaction']};
  let calls = 0;
  let listener = () => {};
  const wallet = {version: '1.0.0', name: 'Test wallet', icon: 'data:image/svg+xml;base64,', chains: ['solana:mainnet'], accounts: [account], features: {
    'standard:connect': {version: '1.0.0', async connect() {calls++; return {accounts: wallet.accounts};}},
    'standard:events': {version: '1.0.0', on(_, callback) {listener = callback; return () => {listener = () => {};};}},
    'solana:signTransaction': {version: '1.0.0', supportedTransactionVersions: ['legacy'], async signTransaction(...inputs) {
      calls++;
      const outputs = inputs.map(input => {
        assert.equal(input.chain, 'solana:mainnet'); assert.equal(input.account.address, account.address);
        const transaction = Transaction.from(input.transaction);
        if (changeTransaction) changeTransaction(transaction, wallet);
        transaction.partialSign(signer);
        if (changeSignedTransaction) changeSignedTransaction(transaction);
        return {signedTransaction: Uint8Array.from(transaction.serialize(changeSignedTransaction ? {requireAllSignatures: false, verifySignatures: false} : undefined))};
      });
      return changeOutputs ? changeOutputs(outputs) : outputs;
    }},
  }};
  return {wallet, account, calls: () => calls, change(accounts) {wallet.accounts = accounts; listener({accounts});}};
}
let passed = 0;
async function check(name, run) {await run(); passed++; console.log('PASS ' + name);}

await check('configuration requires a separate program, trusted binary and HTTPS RPC', () => {
  assert.equal(createMarketConnection(config).programId.toBase58(), config.programId);
  for (const override of [{rpc: 'http://rpc.example.com'}, {rpc: 'https://user:secret@rpc.example.com'}, {cluster: 'testnet'}, {programLength: 0}, {programSha256: ''}, {programId: SOLANA_TREASURY}, {programId: '0x123'}]) assert.throws(() => createMarketConnection({...config, ...override}));
});

await check('program verification pins network, program-data PDA, loader, binary and authority', async () => {
  const good = mockMarket();
  assert.equal((await verifySolanaProgram(good.market)).upgradeAuthority, SOLANA_TREASURY);
  good.accounts.data.data[12] = 0;
  assert.equal((await verifySolanaProgram(good.market)).upgradeAuthority, null, 'immutable authority allowed');
  for (const corrupt of [
    ({market}) => {market.connection.getGenesisHash = async () => SOLANA_GENESIS.devnet;},
    ({accounts}) => {accounts.program.owner = treasury;},
    ({accounts}) => {accounts.program.executable = false;},
    ({accounts}) => {accounts.program.data[4] ^= 1;},
    ({accounts}) => {accounts.data.data[45] ^= 1;},
    ({accounts}) => {accounts.data.data[accounts.data.data.length - 1] = 1;},
    ({accounts}) => {other.publicKey.toBuffer().copy(accounts.data.data, 13);},
    ({accounts}) => {accounts.data.data[12] = 2;},
  ]) {
    const fixture = mockMarket(); corrupt(fixture); await assert.rejects(() => verifySolanaProgram(fixture.market));
  }
});

await check('slot decoding validates account provenance, UTF-8, padding and ownership invariants', () => {
  const pda = slotPda(programId, 0);
  const decode = data => decodeSolanaSlot(programId, 0, pda, info(programId, data));
  const decoded = decode(encodedSlot());
  assert.equal(decoded.owner, buyer.publicKey.toBase58()); assert.equal(decoded.paid, 100_000_000n); assert.equal(decoded.content.text, 'hello');
  assert.deepEqual(decodeSolanaSlot(programId, 0, pda, null), emptySolanaSlot(0));
  assert.deepEqual(decodeSolanaSlot(programId, 0, pda, info(SystemProgram.programId, Buffer.alloc(0))), emptySolanaSlot(0), 'prefunded PDA remains unclaimed');
  assert.throws(() => decodeSolanaSlot(programId, 0, treasury, null));
  assert.throws(() => decodeSolanaSlot(programId, 0, pda, info(treasury, encodedSlot())));
  for (const change of [b => {b[0] = 0;}, b => {b[8] = 1;}, b => {b[58] = 2;}, b => {b.writeUInt16LE(281, 59);}, b => {b[100] = 1;}, b => {b[61] = 255;}, b => {b.fill(0, 50, 58);}, b => {b.fill(0, 42, 50);}]) {
    const bytes = encodedSlot(); change(bytes); assert.throws(() => decode(bytes));
  }
  assert.throws(() => decode(Buffer.alloc(SLOT_ACCOUNT_SIZE - 1)));
});

await check('all 62 PDAs are distinct and read in bounded batches with an advancing context fence', async () => {
  const calls = [];
  const seen = [];
  const {market} = mockMarket({async getMultipleAccountsInfoAndContext(keys, options) {
    calls.push({count: keys.length, ...options});
    seen.push(...keys.map(key => key.toBase58()));
    return {context: {slot: 199 + calls.length}, value: keys.map(() => null)};
  }});
  const read = await readSolanaSlots(market, undefined, 190);
  assert.deepEqual(calls, [
    {count: 62, commitment: 'confirmed', minContextSlot: 190},
  ]);
  assert.equal(new Set(seen).size, 62);
  assert.equal(read.contextSlot, 200, 'the confirmed response fences the next refresh');
  assert.deepEqual(read.states.map(state => state.id), Array.from({length: 62}, (_, id) => id));
  assert.deepEqual(read.accountLamports, Array(62).fill(0n));
  for (const ids of [[], [0, 0], [62], [-1]]) await assert.rejects(() => readSolanaSlots(market, ids));
  assert.equal(calls.length, 1, 'invalid selections must not issue an account read');
});

await check('batched reads preserve requested ID and balance order, including a descending selection', async () => {
  const ids = Array.from({length: 62}, (_, index) => 61 - index);
  const idsByAddress = new Map(ids.map(id => [slotPda(programId, id).toBase58(), id]));
  let calls = 0;
  const {market} = mockMarket({async getMultipleAccountsInfoAndContext(keys, options) {
    assert.equal(options.minContextSlot, undefined);
    assert.equal(keys.length, 62); calls++;
    return {context: {slot: 210}, value: keys.map(key => {
      const id = idsByAddress.get(key.toBase58());
      return {...info(programId, encodedSlot({id, text: `space ${id}`})), lamports: 10_000_000 + id};
    })};
  }});
  const read = await readSolanaSlots(market, ids);
  assert.equal(calls, 1);
  assert.deepEqual(read.states.map(state => [state.id, state.content.text]), ids.map(id => [id, `space ${id}`]));
  assert.deepEqual(read.accountLamports, ids.map(id => BigInt(10_000_000 + id)));
});

await check('slot reads reject invalid or regressing contexts instead of returning a stale partial market', async () => {
  for (const responseSlot of [199, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, '201', undefined]) {
    const {market} = mockMarket({async getMultipleAccountsInfoAndContext(keys) {
      return {context: {slot: responseSlot}, value: keys.map(() => null)};
    }});
    await assert.rejects(() => readSolanaSlots(market, [0], 200), /context/);
  }
  let calls = 0;
  const {market} = mockMarket({async getMultipleAccountsInfoAndContext(keys, options) {
    calls++;
    assert.equal(options.minContextSlot, 220);
    return {context: {slot: 219}, value: keys.map(() => null)};
  }});
  await assert.rejects(() => readSolanaSlots(market, undefined, 220), /stale context/);
  assert.equal(calls, 1);
  for (const minimum of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(() => readSolanaSlots(market, [0], minimum), /minimum slot context/);
  }
  assert.equal(calls, 1, 'invalid caller contexts are rejected before account reads');
});

await check('incomplete, invalid or failed RPC responses reject the whole read', async () => {
  for (const failure of ['short', 'missing', 'balance', 'rpc']) {
    let calls = 0;
    const {market} = mockMarket({async getMultipleAccountsInfoAndContext(keys) {
      calls++;
      if (failure === 'rpc') throw Error('RPC unavailable');
      const value = keys.map(() => null);
      if (failure === 'short') value.pop();
      if (failure === 'missing') value[0] = undefined;
      if (failure === 'balance') value[0] = {...info(SystemProgram.programId, Buffer.alloc(0)), lamports: -1};
      return {context: {slot: 221}, value};
    }});
    await assert.rejects(() => readSolanaSlots(market), /Incomplete|invalid lamport|RPC unavailable/);
    assert.equal(calls, 1);
  }
});

await check('mutating the caller selection during an RPC does not reassign account identities', async () => {
  let release;
  const waiting = new Promise(resolve => {release = resolve;});
  const ids = [2, 0];
  const {market} = mockMarket({
    async getGenesisHash() {await waiting; return SOLANA_GENESIS['mainnet-beta'];},
    async getMultipleAccountsInfoAndContext(keys) {
      assert.deepEqual(keys.map(key => key.toBase58()), [slotPda(programId, 2), slotPda(programId, 0)].map(key => key.toBase58()));
      return {context: {slot: 220}, value: [info(programId, encodedSlot({id: 2})), info(programId, encodedSlot({id: 0}))]};
    },
  });
  const pending = readSolanaSlots(market, ids);
  ids.splice(0, 2, 1, 5);
  release();
  assert.deepEqual((await pending).states.map(state => state.id), [2, 0]);
});

await check('content uses UTF-8 byte bounds and the native program HTTPS grammar', () => {
  assert.equal(validateSlotContent({text: 'é'.repeat(140), image: '', link: ''}).text.length, 140);
  assert.throws(() => validateSlotContent({text: 'é'.repeat(141), image: '', link: ''}));
  assert.equal(validateSlotContent({text: 'line one\n\tline two', image: '', link: ''}).text, 'line one\n\tline two');
  for (const control of ['\u0000', '\u001f', '\u007f', '\u0080', '\u0085', '\u009f']) assert.throws(() => validateSlotContent({text: 'text' + control, image: '', link: ''}), /invalid/);
  for (const url of ['https://example.com/path%20here?q=1', 'https://a.example:443/', 'https://127.0.0.1/a']) assert(validSolanaContentUrl(url));
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://a@example.com', 'https://x.test/a b', 'https://x.test/\\p', 'https://x.test/%gg', 'https://x.test:0', 'https://x.test:65536', 'https://-x.test', 'https://x..test', 'https://x.test/é', 'https://x.test/\"']) assert.equal(validSolanaContentUrl(url), false, url);
});

await check('buy ABI includes exact quote and canonical account ordering; protected IDs do not exist', () => {
  const action = {...basic(), content: {text: 'A', image: '', link: ''}};
  const {instruction, paymentLamports} = buildSolanaInstruction(programId, action);
  assert.equal(instruction.data[0], 0); assert.equal(instruction.data.readUInt16LE(1), 0);
  assert(instruction.data.subarray(3, 35).every(byte => byte === 0));
  assert.equal(instruction.data.readBigUInt64LE(35), 0n); assert.equal(instruction.data.readBigUInt64LE(43), 0n); assert.equal(instruction.data.readBigUInt64LE(51), paymentLamports);
  assert.equal(instruction.data.subarray(59).toString('hex'), '01004100000000');
  assert.deepEqual(instruction.keys.map(k => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [[action.actor, true, true], [slotPda(programId, 0).toBase58(), false, true], [SOLANA_TREASURY, false, true], [SystemProgram.programId.toBase58(), false, false]]);
  assert.throws(() => buildSolanaInstruction(programId, {...action, id: 62}));
  const takeover = {...action, expected: {...action.expected, owner: other.publicKey.toBase58(), paid: 2_000_000_000n, version: 8n, exists: true, locked: true}};
  assert.equal(buildSolanaInstruction(programId, takeover).paymentLamports, 4_000_000_000n, 'a new owner can take over locked content');
  assert.throws(() => buildSolanaInstruction(programId, {...takeover, actor: other.publicKey.toBase58()}), /locked/);
});

await check('owner edits and admin moderation cannot become unauthorised payments', () => {
  const owned = {...emptySolanaSlot(0), exists: true, owner: buyer.publicKey.toBase58(), paid: 100_000_000n, version: 4n};
  const edit = {...basic(), kind: 'edit', expected: owned};
  const result = buildSolanaInstruction(programId, edit); assert.equal(result.paymentLamports, 0n); assert.equal(result.instruction.data[0], 1); assert.equal(result.instruction.data.readBigUInt64LE(3), 4n);
  assert.throws(() => buildSolanaInstruction(programId, {...edit, actor: other.publicKey.toBase58()}));
  assert.throws(() => buildSolanaInstruction(programId, {...edit, expected: {...owned, locked: true}}));
  const admin = buildSolanaInstruction(programId, {...basic(), kind: 'admin', actor: SOLANA_TREASURY, locked: true});
  assert.equal(admin.instruction.data[0], 2); assert.equal(admin.instruction.data[11], 1); assert.equal(admin.paymentLamports, 0n);
  assert.throws(() => buildSolanaInstruction(programId, {...basic(), kind: 'admin', locked: true}));
});

await check('preparation exposes price, rent and fee, rejects stale quotes, and fits legacy packets', async () => {
  const {market} = mockMarket(); const prepared = await prepareSolanaAction(market, basic());
  assert(prepared.paymentLamports >= 100_000_000n && prepared.paymentLamports <= 2_000_000_000n); assert.equal(prepared.rentLamports, 7_000_000n); assert.equal(prepared.feeLamports, 7400n);
  const max = await prepareSolanaAction(market, {...basic(), content: {text: 'a'.repeat(280), image: 'https://example.com/' + 'a'.repeat(236), link: 'https://example.com/' + 'b'.repeat(236)}});
  assert(max.transaction.serialize({requireAllSignatures: false}).length <= 1232);
  const stale = mockMarket({async getMultipleAccountsInfoAndContext() {return {context: {slot: 101}, value: [info(programId, encodedSlot())]};}});
  await assert.rejects(() => prepareSolanaAction(stale.market, basic()), /changed/);
  await assert.rejects(() => prepareSolanaAction(mockMarket({async getBalance() {return 0;}}).market, basic()), /enough SOL/);
  await assert.rejects(() => prepareSolanaAction(mockMarket({async simulateTransaction() {return {value: {err: {InstructionError: [0, {Custom: 6001}]}}};}}).market, basic()), /simulated/);
});

await check('prefunded slot PDAs charge only the rent shortfall and allow an exactly funded buyer', async () => {
  for (const prefunded of [0, 3_000_000, 7_000_000, 9_000_000]) {
    const rentShortfall = Math.max(0, 7_000_000 - prefunded);
    const payment = buildSolanaInstruction(programId, basic()).paymentLamports;
    const {market} = mockMarket({
      async getMultipleAccountsInfoAndContext() {return {context: {slot: 101}, value: [{...info(SystemProgram.programId, Buffer.alloc(0)), lamports: prefunded}]};},
      async getBalance() {return Number(payment) + rentShortfall + 7400;},
    });
    const prepared = await prepareSolanaAction(market, basic());
    assert.equal(prepared.rentLamports, BigInt(rentShortfall));
    market.connection.getBalance = async () => Number(payment) + rentShortfall + 7399;
    await assert.rejects(() => prepareSolanaAction(market, basic()), /enough SOL/);
  }
});

await check('wallet connection is explicit and account changes invalidate the session', async () => {
  const mock = fakeWallet(); assert.equal(mock.calls(), 0); const session = await connectSolanaWallet(mock.wallet); assert.equal(mock.calls(), 1);
  let changed = session; const off = onSolanaAccountChange(session, value => {changed = value;}); mock.change([]); assert.equal(changed, null); off();
  await assert.rejects(() => createSolanaDeploymentSigner(session).signTransaction(new Transaction()));
});

await check('wallet signatures cannot change recipients, values or transaction messages', async () => {
  const {market} = mockMarket(); const prepared = await prepareSolanaAction(market, basic());
  const signed = Transaction.from(prepared.transaction.serialize({requireAllSignatures: false})); signed.partialSign(buyer);
  assert(verifySignedSolanaTransaction(prepared.transaction, signed.serialize(), buyer.publicKey.toBase58()));
  const altered = Transaction.from(prepared.transaction.serialize({requireAllSignatures: false})); altered.instructions.at(-1).data[51] ^= 1; altered.partialSign(buyer);
  assert.throws(() => verifySignedSolanaTransaction(prepared.transaction, altered.serialize(), buyer.publicKey.toBase58()), /changed/);
  assert.throws(() => verifySignedSolanaTransaction(prepared.transaction, prepared.transaction.serialize({requireAllSignatures: false}), buyer.publicKey.toBase58()), /signature/);
});

await check('deployment signing preserves or restores validated temporary signatures after the selected wallet signs the exact message', async () => {
  for (const dropsTemporarySignatures of [false, true]) {
    const mock = fakeWallet(buyer, undefined, {changeSignedTransaction: dropsTemporarySignatures ? tx => {
      for (const item of tx.signatures) if (!item.publicKey.equals(buyer.publicKey)) item.signature = null;
    } : undefined});
    const session = await connectSolanaWallet(mock.wallet);
    const temporary = [Keypair.generate(), Keypair.generate()];
    const tx = new Transaction({feePayer: buyer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200});
    for (const keypair of temporary) tx.add(SystemProgram.createAccount({fromPubkey: buyer.publicKey, newAccountPubkey: keypair.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId}));
    tx.partialSign(...temporary);
    const originalMessage = Buffer.from(tx.serializeMessage());
    const originals = temporary.map(keypair => Buffer.from(tx.signatures.find(s => s.publicKey.equals(keypair.publicKey)).signature));
    const signed = await createSolanaDeploymentSigner(session).signTransaction(tx);
    assert(signed.verifySignatures(), 'the wallet and every temporary keypair signature verify together');
    assert(Buffer.from(signed.serializeMessage()).equals(originalMessage));
    temporary.forEach((keypair, index) => assert(Buffer.from(signed.signatures.find(s => s.publicKey.equals(keypair.publicKey)).signature).equals(originals[index])));
  }
});

await check('deployment signature restoration cannot supply wallet consent, replace a changed signature or sign a changed message', async () => {
  const temporary = Keypair.generate();
  const make = () => {
    const tx = new Transaction({feePayer: buyer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200}).add(SystemProgram.createAccount({fromPubkey: buyer.publicKey, newAccountPubkey: temporary.publicKey, lamports: 1, space: 0, programId: SystemProgram.programId}));
    tx.partialSign(temporary, buyer);
    assert(tx.verifySignatures(), 'the fixture already contains a valid fee-payer signature');
    return tx;
  };
  for (const signature of ['missing', 'invalid']) {
    const mock = fakeWallet(buyer, undefined, {changeSignedTransaction: tx => {
      const walletSignature = tx.signatures.find(item => item.publicKey.equals(buyer.publicKey));
      if (signature === 'missing') walletSignature.signature = null;
      else walletSignature.signature[0] ^= 1;
    }});
    const session = await connectSolanaWallet(mock.wallet);
    await assert.rejects(() => createSolanaDeploymentSigner(session).signTransaction(make()), /signature/i, `a ${signature} wallet signature cannot be restored from the input`);
  }
  const corrupt = fakeWallet(buyer, undefined, {changeSignedTransaction: tx => {tx.signatures.find(item => item.publicKey.equals(temporary.publicKey)).signature[0] ^= 1;}});
  const corruptSession = await connectSolanaWallet(corrupt.wallet);
  await assert.rejects(() => createSolanaDeploymentSigner(corruptSession).signTransaction(make()), /signature/i);

  const changed = fakeWallet(buyer, tx => {tx.instructions[0].data[4] ^= 1;}, {changeSignedTransaction: tx => {
    tx.signatures.find(item => item.publicKey.equals(temporary.publicKey)).signature = null;
  }});
  const changedSession = await connectSolanaWallet(changed.wallet);
  await assert.rejects(() => createSolanaDeploymentSigner(changedSession).signTransaction(make()), /changed/i);

  const missing = fakeWallet(buyer, undefined, {changeSignedTransaction: () => {}});
  const missingSession = await connectSolanaWallet(missing.wallet);
  const unsignedTemporary = make();
  unsignedTemporary.signatures.find(item => item.publicKey.equals(temporary.publicKey)).signature = null;
  await assert.rejects(() => createSolanaDeploymentSigner(missingSession).signTransaction(unsignedTemporary), /signature/i, 'a required co-signature without a validated original remains missing');

  const invalidOriginal = make();
  invalidOriginal.signatures.find(item => item.publicKey.equals(temporary.publicKey)).signature[0] ^= 1;
  const before = missing.calls();
  await assert.rejects(() => createSolanaDeploymentSigner(missingSession).signTransaction(invalidOriginal), /signature/i);
  assert.equal(missing.calls(), before, 'invalid existing signatures are refused before asking the wallet');
});

await check('deployment batch signing preserves order, exact messages and bounds each wallet request', async () => {
  const mock = fakeWallet(); const session = await connectSolanaWallet(mock.wallet);
  const make = amount => new Transaction({feePayer: buyer.publicKey, blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200}).add(SystemProgram.transfer({fromPubkey: buyer.publicKey, toPubkey: treasury, lamports: amount}));
  const transactions = [make(1), make(2), make(3), make(4), make(5)];
  const adapter = createSolanaDeploymentSigner(session);
  const signed = await adapter.signTransactions(transactions); assert.equal(signed.length, 5); assert.equal(mock.calls(), 2, 'one connect and one signing feature call');
  signed.forEach((tx, index) => {assert(tx.verifySignatures()); assert(Buffer.from(tx.serializeMessage()).equals(transactions[index].serializeMessage()));});
  await assert.rejects(() => adapter.signTransactions([])); await assert.rejects(() => adapter.signTransactions([...transactions, make(6)]));
  const changing = fakeWallet(buyer, tx => {tx.instructions[0].data[4] ^= 1;}); const changed = await connectSolanaWallet(changing.wallet);
  await assert.rejects(() => createSolanaDeploymentSigner(changed).signTransactions(transactions), /changed/);
  for (const [changeOutputs, expectedError] of [
    [outputs => outputs.slice(0, -1), /incomplete/i],
    [outputs => outputs.toReversed(), /changed/i],
    [outputs => [{signedTransaction: new Uint8Array(1233)}, ...outputs.slice(1)], /oversized/i],
  ]) {
    const malformed = fakeWallet(buyer, undefined, {changeOutputs});
    const malformedSession = await connectSolanaWallet(malformed.wallet);
    await assert.rejects(() => createSolanaDeploymentSigner(malformedSession).signTransactions(transactions), expectedError);
  }
});

await check('market submission sends once, uses preflight, and confirms the same signature', async () => {
  let sends = 0; let sentSignature; const mock = fakeWallet(); const session = await connectSolanaWallet(mock.wallet);
  const {market} = mockMarket({async sendRawTransaction(bytes, options) {sends++; assert.equal(options.skipPreflight, false); assert.equal(options.maxRetries, 3); assert(Transaction.from(bytes).verifySignatures()); sentSignature = encodeSolanaSignature(Transaction.from(bytes).signature); return sentSignature;}, async getSignatureStatuses(signatures) {assert.deepEqual(signatures, [sentSignature]); return {value: [{err: null, confirmationStatus: 'confirmed'}]};}});
  const prepared = await prepareSolanaAction(market, basic());
  assert.equal(await signAndSendSolanaTransaction(session, prepared), sentSignature); assert.equal(sends, 1);
});

await check('guarded legacy purchase verifies and simulates the complete signed packet before receipt and broadcast',async()=>{
  let sentSignature,saved,sentPacket,signedSimulation;
  const mock=fakeWallet(buyer,addWalletAssertions),session=await connectSolanaWallet(mock.wallet);
  const {market}=mockMarket({
    async simulateTransaction(transaction,options){
      assert(transaction instanceof VersionedTransaction);assert.equal(options.replaceRecentBlockhash,false);
      if(options.sigVerify){
        assert.equal(transaction.version,'legacy');assert(transaction.signatures[0].some(byte=>byte!==0));
        const decoded=Transaction.from(transaction.serialize());assert(decoded.verifySignatures());
        assert.equal(decoded.instructions.filter(ix=>ix.programId.equals(lighthouse)).length,3);
        signedSimulation=Buffer.from(transaction.serialize());
      }
      return {context:{slot:101},value:{err:null}};
    },
    async sendRawTransaction(bytes,options){
      assert(saved,'A signed receipt must be persisted before the guarded purchase is broadcast');
      assert(signedSimulation,'Actual returned bytes must pass signed simulation before broadcast');
      assert.deepEqual(Buffer.from(bytes),signedSimulation,'The guards must remain in exactly the simulated signed packet');
      assert.equal(options.skipPreflight,false);sentPacket=Transaction.from(bytes);assert(sentPacket.verifySignatures());
      sentSignature=encodeSolanaSignature(sentPacket.signature);assert.equal(saved.signature,sentSignature);return sentSignature;
    },
    async getSignatureStatuses(ids){assert.deepEqual(ids,[sentSignature]);return {value:[{err:null,confirmationStatus:'confirmed'}]};},
  });
  const prepared=await prepareSolanaAction(market,basic()),operation=prepared.transaction.instructions.at(-1);
  assert.equal(await signAndSendSolanaTransaction(session,prepared,60_000,receipt=>{saved=receipt;}),sentSignature);
  assert.equal(sentPacket.instructions.length,6);
  const sentOperation=sentPacket.instructions.find(ix=>ix.programId.equals(programId));
  assert.deepEqual(sentOperation.data,operation.data);
  assert.deepEqual(sentOperation.keys.map(key=>key.pubkey.toBase58()),operation.keys.map(key=>key.pubkey.toBase58()));
  assert.equal(saved.actor,buyer.publicKey.toBase58());assert.equal(saved.programId,programId.toBase58());
});

await check('guarded purchase still rejects changed payments and unsupported wallet instructions',async()=>{
  for(const mode of ['payment','unknown-guard']){
    let sends=0,saves=0;
    const mock=fakeWallet(buyer,transaction=>{
      addWalletAssertions(transaction);
      if(mode==='payment')transaction.instructions.find(ix=>ix.programId.equals(programId)).data[51]^=1;
      else transaction.instructions.find(ix=>ix.programId.equals(lighthouse)).data[0]=0;
    });
    const {market}=mockMarket({async sendRawTransaction(){sends++;throw Error('Unexpected broadcast');}});
    const prepared=await prepareSolanaAction(market,basic()),session=await connectSolanaWallet(mock.wallet);
    await assert.rejects(()=>signAndSendSolanaTransaction(session,prepared,60_000,()=>{saves++;}),/changed/);
    assert.equal(sends,0);assert.equal(saves,0);assert.equal(mock.calls(),2);
  }
});

await check('post-wallet guarded fee, simulation and account checks reject before saving or sending a purchase',async()=>{
  for(const mode of ['fee','simulation','account']){
    let sends=0,saves=0,signedSimulations=0;
    const mock=fakeWallet(buyer,addWalletAssertions),session=await connectSolanaWallet(mock.wallet);
    const {market}=mockMarket({
      async getFeeForMessage(message){
        const keys=message.staticAccountKeys??message.accountKeys;
        return {context:{slot:101},value:mode==='fee'&&keys.some(key=>key.equals(lighthouse))?7401:7400};
      },
      async simulateTransaction(transaction,options){
        if(options.sigVerify){
          signedSimulations++;assert(transaction.signatures[0].some(byte=>byte!==0));
          if(mode==='account')mock.change([]);
          if(mode==='simulation')return {context:{slot:101},value:{err:{InstructionError:[2,'Custom']}}};
        }
        return {context:{slot:101},value:{err:null}};
      },
      async sendRawTransaction(){sends++;throw Error('Unexpected broadcast');},
    });
    const prepared=await prepareSolanaAction(market,basic());
    await assert.rejects(()=>signAndSendSolanaTransaction(session,prepared,60_000,()=>{saves++;}),/fee|simulation|simulated|account changed|disconnected/);
    assert.equal(mock.calls(),2);assert.equal(sends,0);assert.equal(saves,0);
    assert.equal(signedSimulations,mode==='fee'?0:1);
  }
});

await check('wallet mutation never sends; ambiguous confirmations retain the receipt and never retry', async () => {
  let sends = 0; let sentSignature;
  const mutate = fakeWallet(buyer, tx => {tx.instructions.at(-1).data[51] ^= 1;}); const session = await connectSolanaWallet(mutate.wallet);
  const {market} = mockMarket({async sendRawTransaction(bytes) {sends++; sentSignature = encodeSolanaSignature(Transaction.from(bytes).signature); return sentSignature;}, async getSignatureStatuses() {throw Error('RPC unavailable');}});
  await assert.rejects(() => prepareSolanaAction(market, basic()).then(prepared => signAndSendSolanaTransaction(session, prepared)), /changed/); assert.equal(sends, 0);
  const normal = fakeWallet(); const normalSession = await connectSolanaWallet(normal.wallet);
  await assert.rejects(() => prepareSolanaAction(market, basic()).then(prepared => signAndSendSolanaTransaction(normalSession, prepared)), error => error instanceof SolanaSubmissionError && error.signature === sentSignature); assert.equal(sends, 1);
  const lost = mockMarket({async sendRawTransaction(bytes) {sends++; sentSignature = encodeSolanaSignature(Transaction.from(bytes).signature); throw Error('RPC response lost after accepting transaction');}});
  await assert.rejects(() => prepareSolanaAction(lost.market, basic()).then(prepared => signAndSendSolanaTransaction(normalSession, prepared)), error => error instanceof SolanaSubmissionError && error.signature === sentSignature); assert.equal(sends, 2);
});

await check('signature base58 preserves leading zero bytes and round trips SDK signatures', async () => {
  assert.equal(encodeSolanaSignature(new Uint8Array(64)), '1'.repeat(64));
  const sample = new Uint8Array(64); sample[63] = 1; assert.equal(encodeSolanaSignature(sample), '1'.repeat(63) + '2');
  assert.throws(() => encodeSolanaSignature(new Uint8Array(32)));
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const prepared = await prepareSolanaAction(mockMarket().market, basic()); prepared.transaction.partialSign(buyer);
  const signature = prepared.transaction.signature; let decoded = 0n;
  for (const character of encodeSolanaSignature(signature)) decoded = decoded * 58n + BigInt(alphabet.indexOf(character));
  assert.equal(decoded.toString(16).padStart(128, '0'), Buffer.from(signature).toString('hex'));
});

await check('explicit quoted priority fees prevent Phantom fee insertion without accepting changed payments', async () => {
  const {market} = mockMarket();
  let signature;
  market.connection.sendRawTransaction = async bytes => signature = encodeSolanaSignature(Transaction.from(bytes).signature);
  market.connection.getSignatureStatuses = async () => ({value: [{err: null, confirmationStatus: 'confirmed'}]});
  let addedByWallet = false;
  const phantomStyle = fakeWallet(buyer, tx => {
    if (!tx.instructions.some(ix => ix.programId.equals(ComputeBudgetProgram.programId))) {
      addedByWallet = true;
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({microLamports: 10_000}));
    }
  });
  const prepared = await prepareSolanaAction(market, basic());
  assert.equal(prepared.transaction.instructions.length, 3);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(prepared.transaction.instructions[0]).units, 200_000);
  assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(prepared.transaction.instructions[1]).microLamports, 12_000n);
  assert.equal(prepared.feeLamports, 7400n);
  await signAndSendSolanaTransaction(await connectSolanaWallet(phantomStyle.wallet), prepared);
  assert.equal(addedByWallet, false);
  assert.equal(client.selectPriorityMicroLamports([{prioritizationFee: 99_999_999}]), 250_000);
  assert.equal(client.selectPriorityMicroLamports([]), 12_000);
});

await check('long review gets a new blockhash while a higher fee requires new consent', async () => {
  const reviewedHash = Keypair.generate().publicKey.toBase58();
  const signingHash = Keypair.generate().publicKey.toBase58();
  let hashCalls = 0; let signature;
  const {market} = mockMarket({
    async getLatestBlockhash() {return {blockhash: ++hashCalls === 1 ? reviewedHash : signingHash, lastValidBlockHeight: 200};},
    async sendRawTransaction(bytes) {const tx = Transaction.from(bytes); assert.equal(tx.recentBlockhash, signingHash); return signature = encodeSolanaSignature(tx.signature);},
    async getSignatureStatuses() {return {value: [{err: null, confirmationStatus: 'confirmed'}]};},
  });
  const prepared = await prepareSolanaAction(market, basic());
  const mock = fakeWallet(); const session = await connectSolanaWallet(mock.wallet);
  assert.equal(await signAndSendSolanaTransaction(session, prepared), signature);
  assert.equal(prepared.transaction.recentBlockhash, reviewedHash, 'the reviewed object stays unchanged');
  market.connection.getFeeForMessage = async () => ({value: 7401});
  await assert.rejects(() => signAndSendSolanaTransaction(session, prepared), /fee increased/);
  assert.equal(mock.calls(), 2, 'higher costs do not open another wallet prompt');
});

await check('stalled submission is bounded and persists its signature before any broadcast', async () => {
  let saved; let sends = 0;
  const {market} = mockMarket({async sendRawTransaction(bytes) {
    sends++; assert(saved); assert.equal(saved.signature, encodeSolanaSignature(Transaction.from(bytes).signature));
    return new Promise(() => {});
  }});
  const prepared = await prepareSolanaAction(market, basic());
  const session = await connectSolanaWallet(fakeWallet().wallet);
  const started = Date.now();
  await assert.rejects(() => signAndSendSolanaTransaction(session, prepared, 1000, receipt => {saved = receipt;}), error => error instanceof SolanaSubmissionError && error.signature === saved.signature);
  assert.equal(sends, 1); assert(Date.now() - started < 3000);
  await assert.rejects(() => signAndSendSolanaTransaction(session, prepared, 1000, () => {throw Error('Storage unavailable');}), /Storage unavailable/);
  assert.equal(sends, 1, 'a receipt-storage failure must stop the send');
});

await check('pending receipts survive reload and need finalized evidence before retry is allowed', async () => {
  const values = new Map(); const storage = {getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k)};
  const {market} = mockMarket(); const prepared = await prepareSolanaAction(market, basic()); prepared.transaction.partialSign(buyer);
  const receipt = {signature: encodeSolanaSignature(prepared.transaction.signature), lastValidBlockHeight: 200, cluster: 'mainnet-beta', programId: programId.toBase58(), actor: buyer.publicKey.toBase58(), slotId: 0};
  receiptApi.savePendingReceipt(storage, market, receipt);
  assert.deepEqual(receiptApi.readPendingReceipt(storage, market), receipt);
  assert.throws(() => receiptApi.savePendingReceipt(storage, market, {...receipt, signature: '2'.repeat(87)}), /Resolve/);
  market.connection.getEpochInfo = async () => ({blockHeight: 201, absoluteSlot: 230});
  market.connection.getSignatureStatuses = async () => ({context: {slot: 229}, value: [null]});
  assert.equal(await receiptApi.inspectPendingReceipt(market, receipt), 'pending', 'stale absence is not expiration proof');
  market.connection.getSignatureStatuses = async () => ({context: {slot: 230}, value: [{err: null, confirmationStatus: 'processed'}]});
  assert.equal(await receiptApi.inspectPendingReceipt(market, receipt), 'pending');
  market.connection.getSignatureStatuses = async () => ({context: {slot: 230}, value: [null]});
  market.connection.getMultipleAccountsInfoAndContext = async (keys, options) => {assert.equal(options.minContextSlot, 230); return {context: {slot: 230}, value: [null]};};
  assert.equal(await receiptApi.inspectPendingReceipt(market, receipt), 'expired');
  market.connection.getSignatureStatuses = async () => ({context: {slot: 230}, value: [{err: null, confirmationStatus: 'confirmed'}]});
  assert.equal(await receiptApi.inspectPendingReceipt(market, receipt), 'confirmed');
  market.connection.getSignatureStatuses = async () => ({context: {slot: 230}, value: [{err: {InstructionError: [2, 'custom']}, confirmationStatus: 'finalized'}]});
  assert.equal(await receiptApi.inspectPendingReceipt(market, receipt), 'failed');
  receiptApi.clearPendingReceipt(storage, market); assert.equal(receiptApi.readPendingReceipt(storage, market), null);
});

console.log(`${passed} Solana client and wallet checks passed. RPCs and wallets were mocked; no transaction or network request was made.`);
