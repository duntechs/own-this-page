import {Buffer} from 'buffer';
import {ComputeBudgetProgram, Connection, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, type AccountInfo} from '@solana/web3.js';
import catalog from './slots.json';
import {quoteLamports} from './solana-pricing';

export const SOLANA_TREASURY = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';
export const SLOT_ACCOUNT_SIZE = 857;
export const SOLANA_GENESIS = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});
export type SolanaCluster = keyof typeof SOLANA_GENESIS;
export type MarketConnectionConfig = {cluster: SolanaCluster; rpc: string; programId: string; programSha256: string; programLength: number};
export type MarketConnection = {config: Readonly<MarketConnectionConfig>; connection: Connection; programId: PublicKey};
export type SlotContent = {text: string; image: string; link: string};
export type SolanaSlotState = {id: number; owner: string | null; paid: bigint; version: bigint; locked: boolean; content: SlotContent; exists: boolean};
export type SolanaAction = {kind: 'buy' | 'edit' | 'admin'; actor: string; id: number; expected: SolanaSlotState; content: SlotContent; locked?: boolean};
export type PreparedSolanaAction = {
  market: MarketConnection; action: SolanaAction; transaction: Transaction;
  blockhash: string; lastValidBlockHeight: number; contextSlot: number;
  paymentLamports: bigint; rentLamports: bigint; feeLamports: bigint; priorityMicroLamports: number;
};

const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const zeroKey = new PublicKey(new Uint8Array(32)).toBase58();
const utf8 = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const maxU64 = (BigInt(1) << BigInt(64)) - BigInt(1);
function fail(message: string): never {throw Error(message);}
function validId(id: number): number {
  if (!Number.isInteger(id) || id < 0 || id >= catalog.length) fail('Unknown advertising slot.');
  return id;
}
function checkedKey(address: string): PublicKey {
  const key = new PublicKey(address);
  if (key.toBase58() !== address || address === zeroKey) fail('Invalid Solana public key.');
  return key;
}
function u16(value: number): Buffer {const out = Buffer.alloc(2); out.writeUInt16LE(value); return out;}
function u64(value: bigint): Buffer {
  if (typeof value !== 'bigint' || value < BigInt(0) || value > maxU64) fail('Invalid unsigned lamport or version value.');
  const out = Buffer.alloc(8); out.writeBigUInt64LE(value); return out;
}

export function createMarketConnection(config: MarketConnectionConfig): MarketConnection {
  if (!Object.hasOwn(SOLANA_GENESIS, config.cluster)) fail('Unsupported Solana cluster.');
  const url = new URL(config.rpc);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('Use an HTTPS Solana RPC endpoint without embedded credentials.');
  if (!/^[a-f0-9]{64}$/.test(config.programSha256) || !Number.isSafeInteger(config.programLength) || config.programLength < 64 || config.programLength > 4 * 1024 * 1024) {
    fail('A reviewed program binary hash and exact byte length are required.');
  }
  const programId = checkedKey(config.programId);
  if (programId.equals(loader) || programId.equals(new PublicKey(SOLANA_TREASURY))) fail('The market program must be a separate deployed program.');
  return {config: Object.freeze({...config}), programId, connection: new Connection(config.rpc, {commitment: 'confirmed', disableRetryOnRateLimit: true, confirmTransactionInitialTimeout: 60_000, fetch: boundedSolanaFetch})};
}

// Every HTTP request, including response-body reads, has a bounded lifetime.
export const boundedSolanaFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
});
export async function withSolanaTimeout<T>(operation: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('The Solana connection timed out. Check the transaction status before retrying.')), Math.max(1, milliseconds));
    })]);
  } finally {clearTimeout(timer!);}
}
export const SLOT_COMPUTE_UNITS = 200_000;
export function selectPriorityMicroLamports(fees: readonly {prioritizationFee: number}[]): number {
  const valid = fees.map(f => f.prioritizationFee).filter(f => Number.isSafeInteger(f) && f >= 0).sort((a,b) => a-b);
  const suggested = valid.length ? valid[Math.min(valid.length - 1, Math.floor(valid.length * .75))] : 10_000;
  return Math.min(250_000, Math.max(10_000, Math.ceil(suggested * 1.2)));
}
export function buildSolanaTransaction(market: MarketConnection, action: SolanaAction, recent: {blockhash: string; lastValidBlockHeight: number}, priorityMicroLamports: number): Transaction {
  if (!Number.isSafeInteger(priorityMicroLamports) || priorityMicroLamports < 10_000 || priorityMicroLamports > 250_000) fail('The priority fee is outside the reviewed limits.');
  return new Transaction({feePayer: checkedKey(action.actor), ...recent}).add(
    ComputeBudgetProgram.setComputeUnitLimit({units: SLOT_COMPUTE_UNITS}),
    ComputeBudgetProgram.setComputeUnitPrice({microLamports: priorityMicroLamports}),
    buildSolanaInstruction(market.programId, action).instruction,
  );
}

export async function verifySolanaNetwork(market: MarketConnection): Promise<void> {
  if (await market.connection.getGenesisHash() !== SOLANA_GENESIS[market.config.cluster]) fail('The RPC is connected to a different Solana network.');
}

// Loader v3 only. The public configuration must pin an independently reviewed
// binary. A mint account, an arbitrary executable, or a different upgrade is
// never sufficient to turn on payments.
export async function verifySolanaProgram(market: MarketConnection): Promise<{contextSlot: number; upgradeAuthority: string | null}> {
  await verifySolanaNetwork(market);
  const program = await market.connection.getAccountInfoAndContext(market.programId, 'confirmed');
  const info = program.value;
  if (!info || !info.executable || !info.owner.equals(loader) || info.data.length !== 36 || info.data.readUInt32LE(0) !== 2) fail('The configured market is not a supported deployed Solana program.');
  const dataKey = new PublicKey(info.data.subarray(4, 36));
  const [expectedDataKey] = PublicKey.findProgramAddressSync([market.programId.toBuffer()], loader);
  if (!dataKey.equals(expectedDataKey)) fail('The program data address is invalid.');
  const result = await market.connection.getAccountInfoAndContext(dataKey, {commitment: 'confirmed', minContextSlot: program.context.slot});
  const data = result.value;
  if (!data || data.executable || !data.owner.equals(loader) || data.data.length < 45 + market.config.programLength || data.data.readUInt32LE(0) !== 3) fail('The market program data is unavailable or invalid.');
  const option = data.data[12];
  if (option !== 0 && option !== 1) fail('The program upgrade authority is invalid.');
  const authority = option === 1 ? new PublicKey(data.data.subarray(13, 45)).toBase58() : null;
  if (authority !== null && authority !== SOLANA_TREASURY) fail('The program upgrade authority does not match the project admin.');
  const binary = data.data.subarray(45, 45 + market.config.programLength);
  if (data.data.subarray(45 + market.config.programLength).some(byte => byte !== 0)) fail('The deployed program has unexpected trailing code.');
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(binary))).toString('hex');
  if (hash !== market.config.programSha256) fail('The deployed program does not match the approved binary.');
  return {contextSlot: result.context.slot, upgradeAuthority: authority};
}

export function slotPda(programId: PublicKey, id: number): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('slot'), u16(validId(id))], programId)[0];
}

export function validateSlotContent(content: SlotContent): SlotContent {
  if (!content || typeof content !== 'object') fail('Slot content is required.');
  const limits = {text: 280, image: 256, link: 256};
  for (const key of ['text', 'image', 'link'] as const) {
    const value = content[key];
    if (typeof value !== 'string' || utf8.encode(value).length > limits[key] || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) fail(`The slot ${key} is invalid or too long.`);
    if (key !== 'text' && value) {
      if (!validSolanaContentUrl(value)) fail(`The slot ${key} must be an HTTPS URL without credentials.`);
    }
  }
  return {...content};
}

// Match the native program's deliberately narrow URL grammar byte-for-byte.
export function validSolanaContentUrl(value: string): boolean {
  if (value === '') return true;
  if (!value.startsWith('https://') || /[^\x21-\x7e]|[\\"'<>`]/.test(value)) return false;
  const authority = value.slice(8).split(/[/?#]/, 1)[0];
  if (!authority || authority.includes('@')) return false;
  const [host, ...ports] = authority.split(':');
  if (ports.length > 1 || ports.length === 1 && (!/^\d+$/.test(ports[0]) || Number(ports[0]) < 1 || Number(ports[0]) > 65535)) return false;
  if (!host || host.length > 253 || host.split('.').some(label => !label || label.length > 63 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label))) return false;
  return !/%(?![A-Fa-f0-9]{2})/.test(value);
}

export function emptySolanaSlot(id: number): SolanaSlotState {
  return {id: validId(id), owner: null, paid: BigInt(0), version: BigInt(0), locked: false, content: {text: '', image: '', link: ''}, exists: false};
}

export function decodeSolanaSlot(programId: PublicKey, id: number, address: PublicKey, account: AccountInfo<Buffer> | null): SolanaSlotState {
  if (!address.equals(slotPda(programId, id))) fail('The slot account address does not match its program and ID.');
  if (!account) return emptySolanaSlot(id);
  if (!account.executable && account.owner.equals(SystemProgram.programId) && account.data.length === 0) return emptySolanaSlot(id);
  if (account.executable || !account.owner.equals(programId) || account.data.length !== SLOT_ACCOUNT_SIZE) fail('The slot account has an unexpected owner or size.');
  const data = account.data;
  if (data.subarray(0, 8).toString('ascii') !== 'SLOTMKT1' || data.readUInt16LE(8) !== id || data[58] > 1) fail('The slot account header is invalid.');
  const ownerString = new PublicKey(data.subarray(10, 42)).toBase58();
  const paid = data.readBigUInt64LE(42);
  const version = data.readBigUInt64LE(50);
  const owner = ownerString === zeroKey ? null : ownerString;
  if ((owner === null) !== (paid === BigInt(0)) || version === BigInt(0)) fail('The slot ownership state is invalid.');
  const readText = (offset: number, capacity: number) => {
    const length = data.readUInt16LE(offset);
    if (length > capacity || data.subarray(offset + 2 + length, offset + 2 + capacity).some(byte => byte !== 0)) fail('The slot content encoding is invalid.');
    return decoder.decode(data.subarray(offset + 2, offset + 2 + length));
  };
  const content = validateSlotContent({text: readText(59, 280), image: readText(341, 256), link: readText(599, 256)});
  return {id, owner, paid, version, locked: data[58] === 1, content, exists: true};
}

export async function readSolanaSlots(market: MarketConnection, ids = catalog.map((_, id) => id), minimumContextSlot?: number): Promise<{contextSlot: number; states: SolanaSlotState[]; accountLamports: bigint[]}> {
  if (ids.length === 0 || ids.length > catalog.length || new Set(ids).size !== ids.length) fail('Invalid slot selection.');
  if (minimumContextSlot !== undefined && (!Number.isSafeInteger(minimumContextSlot) || minimumContextSlot < 0)) fail('Invalid minimum slot context.');
  // Snapshot the selection before awaiting RPCs so a caller cannot change which
  // IDs are paired with the returned accounts while a batch is in flight.
  const selectedIds = [...ids];
  const addresses = selectedIds.map(id => slotPda(market.programId, id));
  await verifySolanaNetwork(market);
  const states: SolanaSlotState[] = [];
  const accountLamports: bigint[] = [];
  let contextSlot = minimumContextSlot;
  // Solana limits getMultipleAccounts to 100 addresses. Each later batch must
  // be at least as recent as the preceding response, and every batch must meet
  // the caller's freshness floor. This is a collection of confirmed reads, not
  // an atomic snapshot across batches. The returned highest context fences the
  // next refresh; purchase preparation still rereads its single selected slot.
  for (let start = 0; start < selectedIds.length; start += 100) {
    const batchAddresses = addresses.slice(start, start + 100);
    const result = await market.connection.getMultipleAccountsInfoAndContext(batchAddresses, {
      commitment: 'confirmed', ...(contextSlot === undefined ? {} : {minContextSlot: contextSlot}),
    });
    const responseSlot = result.context?.slot;
    if (!Number.isSafeInteger(responseSlot) || responseSlot < 0 || (contextSlot !== undefined && responseSlot < contextSlot)) fail('The slot account response has an invalid or stale context.');
    if (!Array.isArray(result.value) || result.value.length !== batchAddresses.length) fail('Incomplete slot account response.');
    for (let index = 0; index < batchAddresses.length; index++) {
      const account = result.value[index];
      if (account !== null && (!account || !Number.isSafeInteger(account.lamports) || account.lamports < 0)) fail('The slot account has an invalid lamport balance.');
      accountLamports.push(account === null ? BigInt(0) : BigInt(account.lamports));
      states.push(decodeSolanaSlot(market.programId, selectedIds[start + index], batchAddresses[index], account));
    }
    contextSlot = responseSlot;
  }
  return {contextSlot: contextSlot!, accountLamports, states};
}

export function sameSolanaQuote(a: SolanaSlotState, b: SolanaSlotState): boolean {
  return a.id === b.id && a.owner === b.owner && a.paid === b.paid && a.version === b.version && a.locked === b.locked && a.exists === b.exists;
}

export function buildSolanaInstruction(programId: PublicKey, action: SolanaAction): {instruction: TransactionInstruction; paymentLamports: bigint} {
  const id = validId(action.id);
  if (action.expected.id !== id) fail('The quote is for a different slot.');
  const actor = checkedKey(action.actor);
  const content = validateSlotContent(action.content);
  const fields = [content.text, content.image, content.link].map(value => {const bytes = Buffer.from(value, 'utf8'); return Buffer.concat([u16(bytes.length), bytes]);});
  let paymentLamports = BigInt(0);
  let header: Buffer;
  if (action.kind === 'buy') {
    if (action.expected.locked && action.expected.owner === action.actor) fail('The admin locked this content; its current owner cannot reset the lock by buying it again.');
    paymentLamports = quoteLamports(catalog[id], action.expected.paid);
    header = Buffer.concat([Buffer.from([0]), u16(id), new PublicKey(action.expected.owner ?? zeroKey).toBuffer(), u64(action.expected.paid), u64(action.expected.version), u64(paymentLamports)]);
  } else if (action.kind === 'edit') {
    if (action.expected.locked || action.expected.owner !== action.actor || !action.expected.exists) fail('Only the owner can edit an unlocked, purchased slot.');
    header = Buffer.concat([Buffer.from([1]), u16(id), u64(action.expected.version)]);
  } else if (action.kind === 'admin') {
    if (action.actor !== SOLANA_TREASURY || typeof action.locked !== 'boolean') fail('The configured admin and a lock setting are required.');
    header = Buffer.concat([Buffer.from([2]), u16(id), u64(action.expected.version), Buffer.from([action.locked ? 1 : 0])]);
  } else fail('Unknown marketplace operation.');
  return {paymentLamports, instruction: new TransactionInstruction({programId, keys: [
    {pubkey: actor, isSigner: true, isWritable: true},
    {pubkey: slotPda(programId, id), isSigner: false, isWritable: true},
    {pubkey: new PublicKey(SOLANA_TREASURY), isSigner: false, isWritable: true},
    {pubkey: SystemProgram.programId, isSigner: false, isWritable: false},
  ], data: Buffer.concat([header, ...fields])})};
}

export async function prepareSolanaAction(market: MarketConnection, action: SolanaAction): Promise<PreparedSolanaAction> {
  const verified = await verifySolanaProgram(market);
  const read = await readSolanaSlots(market, [action.id], verified.contextSlot);
  if (!sameSolanaQuote(action.expected, read.states[0])) fail('This slot changed. Refresh its price and content before trying again.');
  const savedAction = {...action, expected: {...action.expected, content: {...action.expected.content}}, content: validateSlotContent(action.content)};
  const {paymentLamports} = buildSolanaInstruction(market.programId, savedAction);
  const priorityMicroLamports = selectPriorityMicroLamports(await market.connection.getRecentPrioritizationFees({lockedWritableAccounts: [checkedKey(action.actor), slotPda(market.programId, action.id), new PublicKey(SOLANA_TREASURY)]}));
  const recent = await market.connection.getLatestBlockhash({commitment: 'confirmed', minContextSlot: read.contextSlot});
  const transaction = buildSolanaTransaction(market, savedAction, recent, priorityMicroLamports);
  // Keep compatibility with wallets supporting legacy packets. Both payload and
  // rent are known before a wallet signature is requested.
  try {
    if (transaction.serialize({requireAllSignatures: false, verifySignatures: false}).length > 1232) fail('This content is too large for one transaction. Shorten the text or URLs.');
  } catch {fail('This content is too large for one transaction. Shorten the text or URLs.');}
  let rentLamports = BigInt(0);
  if (!read.states[0].exists) {
    const minimumRent = await market.connection.getMinimumBalanceForRentExemption(SLOT_ACCOUNT_SIZE, 'confirmed');
    if (!Number.isSafeInteger(minimumRent) || minimumRent < 0) fail('The new slot account deposit is unavailable.');
    const shortfall = BigInt(minimumRent) - read.accountLamports[0];
    rentLamports = shortfall > BigInt(0) ? shortfall : BigInt(0);
  }
  const fee = await market.connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
  if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) fail('The network fee is not available. Refresh the quote.');
  const feeLamports = BigInt(fee.value);
  const balance = await market.connection.getBalance(checkedKey(action.actor), {commitment: 'confirmed', minContextSlot: read.contextSlot});
  if (!Number.isSafeInteger(balance) || balance < 0 || BigInt(balance) < paymentLamports + rentLamports + feeLamports) fail('Your wallet needs enough SOL for the slot price, new-account rent, and network fee.');
  const simulation = await market.connection.simulateTransaction(new VersionedTransaction(transaction.compileMessage()), {sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', minContextSlot: read.contextSlot});
  if (simulation.value.err) fail('The slot action could not be simulated. Refresh its state before trying again.');
  return {market, action: savedAction, transaction, ...recent, contextSlot: read.contextSlot, paymentLamports, rentLamports, feeLamports, priorityMicroLamports};
}
