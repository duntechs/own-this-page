import {Buffer} from 'buffer';
import {ComputeBudgetProgram, Connection, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction, type AccountInfo} from '@solana/web3.js';
import {SOLANA_GENESIS, SOLANA_TREASURY, selectPriorityMicroLamports, withSolanaTimeout, type SolanaCluster} from './solana-client';
import {encodeSolanaSignature} from './solana-wallet';
import {validateSolanaTransactionCompatibility} from './solana-transaction-compatibility';
import {DeploymentRpcError} from './solana-deployment-fetch';
export {DeploymentRpcError} from './solana-deployment-fetch';

// The release is pinned independently of anything supplied by localStorage or
// an uploaded configuration. A replacement release requires a new review.
export const DEPLOYMENT_PROGRAM_SHA256 = '0bfd88426f4163f805d8b39026e145c2d0baa66063223a87e27e75a148c7c3bf';
export const DEPLOYMENT_PROGRAM_LENGTH = 105016;
// Leave room in Solana's 1,232-byte packet for supported wallet assertions.
export const DEPLOYMENT_WRITE_BYTES = 700;
const LEGACY_DEPLOYMENT_WRITE_BYTES = 900;
export const DEPLOYMENT_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const OWNER = new PublicKey(SOLANA_TREASURY);
const BUFFER_HEADER = 37, PROGRAM_HEADER = 36, DATA_HEADER = 45;
const MAX_PRIORITY = 250_000;
const CONFIRM_MS = 90_000;
const COMMITMENT = 'confirmed' as const;

export type DeploymentSigner = {publicKey: PublicKey; assertCurrentAccount(): void | Promise<void>; signTransactions(transactions: VersionedTransaction[]): Promise<VersionedTransaction[]>};
export type DeploymentStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type DeploymentProgress = {stage: 'checking' | 'signing' | 'confirming' | 'uploading' | 'paused' | 'verified'; message: string; writtenBytes: number; totalBytes: number; signature?: string; programId?: string};
export type DeploymentResult = {programId: string; signature: string; programSha256: string; programLength: number; cluster: SolanaCluster};
export type DeploymentEstimate = {requiredLamports: number; remainingNetworkFeesLamports: number; bufferRentLamports: number; programRentLamports: number; programDataRentLamports: number; remainingTransactions: number; writtenBytes: number; totalBytes: number; pendingTransactions: number; programId: string; bufferId: string};
export type DeploymentInspection = {stage: 'new' | 'uploading' | 'pending' | 'verified'; bufferId?: string; programId?: string; writtenBytes: number; totalBytes: number; pendingTransactions: number; result?: DeploymentResult};
export type DeploymentSimulationReport = {
  diagnosticVersion: 'otp-simulation-1';
  phase: 'before-wallet' | 'after-wallet';
  action: 'buffer' | 'write' | 'deploy';
  offset: number | null;
  writeLength: number | null;
  bufferId: string;
  programId: string;
  simulationContextSlot: number | null;
  minimumContextSlot: number;
  unitsConsumed: number | null;
  requestedCompute: {limit: number; priceMicroLamports: number};
  error: {kind: string; instructionIndex?: number; instructionError?: string; customCode?: number};
  failedProgram: string | null;
};
export class DeploymentSimulationError extends Error {
  readonly report: DeploymentSimulationReport;
  constructor(report: DeploymentSimulationReport) {
    super(report.phase === 'before-wallet' ? 'A deployment transaction failed simulation. No wallet approval or new payment was requested.' : 'The signed deployment transaction failed simulation. Nothing new was submitted.');
    this.name = 'DeploymentSimulationError'; this.report = report;
  }
}
type Action = {kind: 'buffer' | 'write' | 'deploy'; offset?: number; writeLength?: number; rentLamports: number};
type Pending = Action & {signature: string; raw: string; blockhash: string; lastValidBlockHeight: number; priority: number; feeLamports: number};
type Checkpoint = {version: 1; cluster: SolanaCluster; wallet: string; programSha256: string; bufferSeed: string; programSeed: string; bufferId: string; programId: string; minimumContextSlot: number; pending: Pending[]; walletAssertions?: boolean; finalSignature?: string; finalConfirmed?: boolean};
type ChainState = {buffer: AccountInfo<Buffer> | null; program: AccountInfo<Buffer> | null; missingOffsets: number[]; writtenBytes: number; result?: DeploymentResult};
export class DeploymentPausedError extends Error {constructor(message = 'Deployment paused. Your saved upload will be checked before resuming.') {super(message); this.name = 'DeploymentPausedError';}}

function integer(value: number, label: string): number {if (!Number.isSafeInteger(value) || value < 0) throw Error(`Invalid ${label}.`); return value;}
function sum(...values: number[]): number {return integer(values.reduce((a,b) => a + b, 0), 'deployment amount');}
function equal(a: Uint8Array, b: Uint8Array) {return Buffer.from(a).equals(Buffer.from(b));}
function u32(value: number) {const b = Buffer.alloc(4); b.writeUInt32LE(integer(value, 'instruction number')); return b;}
function u64(value: number) {const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(integer(value, 'instruction number'))); return b;}
function randomSeed() {return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex');}
const hash = async (bytes: Uint8Array) => Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))).toString('hex');
export const deploymentProgramDataAddress = (program: PublicKey) => PublicKey.findProgramAddressSync([program.toBytes()], DEPLOYMENT_LOADER)[0];

// Simulation diagnostics contain public account IDs and bounded protocol
// identifiers only. Never forward RPC log strings, raw packets, signatures,
// stored seeds, or arbitrary error properties into the shareable report.
const diagnosticNumber = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
// Protocol enum names from the pinned solana-transaction-error and
// solana-instruction 2.2.1 sources. New/unknown names remain redacted until
// explicitly reviewed; a short arbitrary string could still be a secret.
const SIMULATION_ERROR_IDENTIFIERS = new Set(`AccountInUse AccountLoadedTwice AccountNotFound ProgramAccountNotFound InsufficientFundsForFee InvalidAccountForFee AlreadyProcessed BlockhashNotFound CallChainTooDeep MissingSignatureForFee InvalidAccountIndex SignatureFailure InvalidProgramForExecution SanitizeFailure ClusterMaintenance AccountBorrowOutstanding WouldExceedMaxBlockCostLimit UnsupportedVersion InvalidWritableAccount WouldExceedMaxAccountCostLimit WouldExceedAccountDataBlockLimit TooManyAccountLocks AddressLookupTableNotFound InvalidAddressLookupTableOwner InvalidAddressLookupTableData InvalidAddressLookupTableIndex InvalidRentPayingAccount WouldExceedMaxVoteCostLimit WouldExceedAccountDataTotalLimit MaxLoadedAccountsDataSizeExceeded InvalidLoadedAccountsDataSizeLimit ResanitizationNeeded UnbalancedTransaction ProgramCacheHitMaxLimit CommitCancelled GenericError InvalidArgument InvalidInstructionData InvalidAccountData AccountDataTooSmall InsufficientFunds IncorrectProgramId MissingRequiredSignature AccountAlreadyInitialized UninitializedAccount UnbalancedInstruction ModifiedProgramId ExternalAccountLamportSpend ExternalAccountDataModified ReadonlyLamportChange ReadonlyDataModified DuplicateAccountIndex ExecutableModified RentEpochModified NotEnoughAccountKeys AccountDataSizeChanged AccountNotExecutable AccountBorrowFailed DuplicateAccountOutOfSync Custom InvalidError ExecutableDataModified ExecutableLamportChange ExecutableAccountNotRentExempt UnsupportedProgramId CallDepth MissingAccount ReentrancyNotAllowed MaxSeedLengthExceeded InvalidSeeds InvalidRealloc ComputationalBudgetExceeded PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToComplete ProgramFailedToCompile Immutable IncorrectAuthority AccountNotRentExempt InvalidAccountOwner ArithmeticOverflow UnsupportedSysvar IllegalOwner MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded BuiltinProgramsMustConsumeComputeUnits`.split(' '));
const diagnosticIdentifier = (value: unknown): value is string => typeof value === 'string' && SIMULATION_ERROR_IDENTIFIERS.has(value);
function simulationErrorDetail(value: unknown): DeploymentSimulationReport['error'] {
  if (diagnosticIdentifier(value)) return {kind: value};
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && 'InstructionError' in value) {
    const instruction = value.InstructionError;
    if (Array.isArray(instruction) && instruction.length === 2 && diagnosticNumber(instruction[0], 255) !== null) {
      if (diagnosticIdentifier(instruction[1])) return {kind: 'InstructionError', instructionIndex: instruction[0], instructionError: instruction[1]};
      if (instruction[1] && typeof instruction[1] === 'object' && !Array.isArray(instruction[1]) && Object.keys(instruction[1]).length === 1 && diagnosticNumber(instruction[1].Custom, 0xffff_ffff) !== null) return {kind: 'InstructionError', instructionIndex: instruction[0], instructionError: 'Custom', customCode: instruction[1].Custom};
    }
  }
  return {kind: 'UnrecognizedSimulationError'};
}

function simulationFailure(phase: DeploymentSimulationReport['phase'], state: Checkpoint, action: Action, transaction: VersionedTransaction, priority: number,
  result: {context: {slot: number}; value: {err: unknown; unitsConsumed?: number}}): DeploymentSimulationError {
  const error = simulationErrorDetail(result.value.err);
  const instruction = error.instructionIndex === undefined ? undefined : transaction.message.compiledInstructions[error.instructionIndex];
  return new DeploymentSimulationError({diagnosticVersion: 'otp-simulation-1', phase, action: action.kind, offset: action.offset ?? null, writeLength: action.writeLength ?? null,
    bufferId: state.bufferId, programId: state.programId, simulationContextSlot: diagnosticNumber(result.context.slot), minimumContextSlot: state.minimumContextSlot,
    unitsConsumed: diagnosticNumber(result.value.unitsConsumed), requestedCompute: {limit: action.kind === 'deploy' ? 1_400_000 : 200_000, priceMicroLamports: priority}, error,
    failedProgram: instruction ? transaction.message.staticAccountKeys[instruction.programIdIndex]?.toBase58() ?? null : null});
}

// ABI independently checked against solana-loader-v3-interface 3.0.0,
// instruction.rs and solana-bpf-loader-program 2.2.4, both in the pinned Cargo
// sources. Public source: https://docs.rs/solana-loader-v3-interface/3.0.0/src/solana_loader_v3_interface/instruction.rs.html
// Init and final deploy MUST share a transaction with their account creation.
// createAccountWithSeed uses only the owner's signature; no program/buffer
// private key exists, and the random public seeds are safe to persist.
function loaderInstructions(state: Checkpoint, action: Action, binary: Uint8Array): TransactionInstruction[] {
  const buffer = new PublicKey(state.bufferId), program = new PublicKey(state.programId);
  const create = (address: PublicKey, seed: string, space: number) => SystemProgram.createAccountWithSeed({fromPubkey: OWNER, newAccountPubkey: address, basePubkey: OWNER, seed, lamports: action.rentLamports, space, programId: DEPLOYMENT_LOADER});
  if (action.kind === 'buffer') return [create(buffer, state.bufferSeed, BUFFER_HEADER + binary.length), new TransactionInstruction({programId: DEPLOYMENT_LOADER, data: u32(0), keys: [{pubkey: buffer, isSigner: false, isWritable: true}, {pubkey: OWNER, isSigner: false, isWritable: false}]})];
  if (action.kind === 'write') {
    const offset = integer(action.offset!, 'upload offset');
    // Version-1 receipts created before wallet assertions used 900-byte writes
    // and did not store a length. Reconstruct those exact signed bytes.
    const length = action.writeLength === undefined ? Math.min(LEGACY_DEPLOYMENT_WRITE_BYTES, binary.length - offset) : integer(action.writeLength, 'upload length');
    if (offset >= binary.length || !length || length > LEGACY_DEPLOYMENT_WRITE_BYTES || offset + length > binary.length || action.rentLamports !== 0) throw Error('Invalid upload range.');
    const bytes = binary.subarray(offset, offset + length);
    return [new TransactionInstruction({programId: DEPLOYMENT_LOADER, data: Buffer.concat([u32(1), u32(offset), u64(bytes.length), Buffer.from(bytes)]), keys: [{pubkey: buffer, isSigner: false, isWritable: true}, {pubkey: OWNER, isSigner: true, isWritable: false}]})];
  }
  if (action.kind !== 'deploy') throw Error('Unknown deployment action.');
  return [create(program, state.programSeed, PROGRAM_HEADER), new TransactionInstruction({programId: DEPLOYMENT_LOADER, data: Buffer.concat([u32(2), u64(binary.length)]), keys: [
    {pubkey: OWNER, isSigner: true, isWritable: true}, {pubkey: deploymentProgramDataAddress(program), isSigner: false, isWritable: true}, {pubkey: program, isSigner: false, isWritable: true}, {pubkey: buffer, isSigner: false, isWritable: true},
    {pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false}, {pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false}, {pubkey: SystemProgram.programId, isSigner: false, isWritable: false}, {pubkey: OWNER, isSigner: true, isWritable: false},
  ]})];
}

function transactionFor(state: Checkpoint, action: Action, binary: Uint8Array, blockhash: string, priority: number) {
  if (!Number.isSafeInteger(priority) || priority < 10_000 || priority > MAX_PRIORITY) throw Error('Deployment priority price is outside the allowed range.');
  const instructions = [ComputeBudgetProgram.setComputeUnitLimit({units: action.kind === 'deploy' ? 1_400_000 : 200_000}), ComputeBudgetProgram.setComputeUnitPrice({microLamports: priority}), ...loaderInstructions(state, action, binary)];
  return new VersionedTransaction(new TransactionMessage({payerKey: OWNER, recentBlockhash: blockhash, instructions}).compileToV0Message());
}

async function checkSignature(transaction: VersionedTransaction, expectedMessage: Uint8Array) {
  const compatibility = validateSolanaTransactionCompatibility(expectedMessage, transaction.message);
  if (transaction.version !== 0 || !compatibility.compatible || transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1 || !transaction.message.staticAccountKeys[0].equals(OWNER)) throw Error('The wallet changed the deployment transaction. Nothing new was submitted.');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(OWNER.toBytes()), {name: 'Ed25519'}, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(transaction.signatures[0]), Uint8Array.from(transaction.message.serialize()))) throw Error('The deployment wallet signature is invalid. Nothing new was submitted.');
  if (transaction.serialize().length > 1232) throw Error('The signed deployment packet is too large.');
  return compatibility.guarded;
}

export class DeploymentEngine {
  readonly connection: Connection;
  readonly cluster: SolanaCluster;
  private readonly binary: Uint8Array;
  private readonly storage: DeploymentStorage;
  private readonly onUpdate?: (progress: DeploymentProgress) => void;
  private state: Checkpoint | null = null;
  private paused = false;
  private running = false;
  private validatedBinary: Promise<void> | null = null;
  private written = 0;
  private settledOutcomes = new Map<string, 'confirmed' | 'failed' | 'expired'>();

  constructor(options: {connection: Connection; binary: Uint8Array; cluster?: SolanaCluster; storage: DeploymentStorage; onUpdate?: (progress: DeploymentProgress) => void}) {
    this.connection = options.connection; this.binary = Uint8Array.from(options.binary); this.cluster = options.cluster ?? 'mainnet-beta'; this.storage = options.storage; this.onUpdate = options.onUpdate;
    if (!Object.hasOwn(SOLANA_GENESIS, this.cluster)) throw Error('Unsupported deployment cluster.');
  }
  private get storageKey() {return `own-page:deployment:v1:${this.cluster}:${SOLANA_TREASURY}`;}
  private rpc<T>(operation: Promise<T>) {return withSolanaTimeout(operation, 15_000);}
  private update(stage: DeploymentProgress['stage'], message: string, signature?: string) {this.onUpdate?.({stage, message, writtenBytes: this.written, totalBytes: this.binary.length, signature, programId: this.state?.programId});}
  private async ready() {
    this.validatedBinary ??= (async () => {if (this.binary.length !== DEPLOYMENT_PROGRAM_LENGTH || await hash(this.binary) !== DEPLOYMENT_PROGRAM_SHA256) throw Error('The program file does not match the approved Own This Page release.');})();
    await this.validatedBinary;
    if (await this.rpc(this.connection.getGenesisHash()) !== SOLANA_GENESIS[this.cluster]) throw Error('The RPC is connected to the wrong Solana network.');
  }
  private async load(create = false) {
    const raw = this.storage.getItem(this.storageKey);
    if (!raw) {
      this.state = null;
      if (!create) return;
      const bufferSeed = randomSeed(), programSeed = randomSeed();
      this.state = {version: 1, cluster: this.cluster, wallet: SOLANA_TREASURY, programSha256: DEPLOYMENT_PROGRAM_SHA256, bufferSeed, programSeed,
        bufferId: (await PublicKey.createWithSeed(OWNER, bufferSeed, DEPLOYMENT_LOADER)).toBase58(), programId: (await PublicKey.createWithSeed(OWNER, programSeed, DEPLOYMENT_LOADER)).toBase58(), minimumContextSlot: 0, pending: []};
      this.save(); return;
    }
    const s = JSON.parse(raw) as Checkpoint;
    if (!s || s.version !== 1 || s.cluster !== this.cluster || s.wallet !== SOLANA_TREASURY || s.programSha256 !== DEPLOYMENT_PROGRAM_SHA256 || !/^[a-f0-9]{32}$/.test(s.bufferSeed) || !/^[a-f0-9]{32}$/.test(s.programSeed) || s.bufferSeed === s.programSeed || !Array.isArray(s.pending) || s.pending.length > 5) throw Error('The saved deployment does not match this owner, network, or release. Keep the saved record for recovery.');
    integer(s.minimumContextSlot, 'saved confirmation context');
    if (s.walletAssertions !== undefined && typeof s.walletAssertions !== 'boolean') throw Error('Invalid saved wallet assertion mode.');
    if ((await PublicKey.createWithSeed(OWNER, s.bufferSeed, DEPLOYMENT_LOADER)).toBase58() !== s.bufferId || (await PublicKey.createWithSeed(OWNER, s.programSeed, DEPLOYMENT_LOADER)).toBase58() !== s.programId || s.programId === s.bufferId) throw Error('The saved deployment addresses are invalid.');
    for (const p of s.pending) {
      integer(p.rentLamports, 'saved account deposit'); integer(p.lastValidBlockHeight, 'saved expiry'); integer(p.feeLamports, 'saved network fee');
      if (typeof p.raw !== 'string' || p.raw.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.raw)) throw Error('The saved signed deployment packet is invalid.');
      const tx = VersionedTransaction.deserialize(Buffer.from(p.raw, 'base64'));
      const expected = transactionFor(s, p, this.binary, p.blockhash, p.priority);
      if (await checkSignature(tx, expected.message.serialize())) s.walletAssertions = true;
      if (encodeSolanaSignature(tx.signatures[0]) !== p.signature) throw Error('The saved deployment receipt does not match its signed transaction.');
    }
    if (s.finalSignature !== undefined && !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(s.finalSignature)) throw Error('Invalid saved deployment signature.');
    if (s.finalConfirmed && !s.finalSignature) throw Error('The saved final confirmation has no receipt.');
    this.state = s;
  }
  private save() {
    if (!this.state) throw Error('No deployment checkpoint.');
    const serialized = JSON.stringify(this.state);
    this.storage.setItem(this.storageKey, serialized);
    if (this.storage.getItem(this.storageKey) !== serialized) throw Error('The deployment recovery record could not be saved. No new transaction was submitted.');
  }
  private async account(key: PublicKey) {
    const s = this.state;
    const result = await this.rpc(this.connection.getAccountInfoAndContext(key, {commitment: COMMITMENT, minContextSlot: s?.minimumContextSlot ?? 0}));
    const slot = integer(result.context.slot, 'RPC account context');
    if (s && slot < s.minimumContextSlot) throw Error('The RPC returned an older account snapshot.');
    if (s) s.minimumContextSlot = slot;
    return result.value;
  }
  private result(programId: string, signature = this.state?.programId === programId ? this.state.finalSignature ?? '' : ''): DeploymentResult {return {programId, signature, programSha256: DEPLOYMENT_PROGRAM_SHA256, programLength: this.binary.length, cluster: this.cluster};}
  private async verifyAccount(programId: string): Promise<DeploymentResult> {
    const program = new PublicKey(programId);
    if (program.equals(OWNER) || program.equals(DEPLOYMENT_LOADER)) throw Error('Enter the marketplace program address, not your wallet or a token mint.');
    const account = await this.account(program), expectedData = deploymentProgramDataAddress(program);
    if (!account || !account.executable || !account.owner.equals(DEPLOYMENT_LOADER) || account.data.length !== PROGRAM_HEADER || account.data.readUInt32LE(0) !== 2 || !equal(account.data.subarray(4), expectedData.toBytes())) throw Error('The marketplace program has not been deployed or does not have the expected loader.');
    const data = await this.account(expectedData);
    if (!data || data.executable || !data.owner.equals(DEPLOYMENT_LOADER) || data.data.length < DATA_HEADER + this.binary.length || data.data.readUInt32LE(0) !== 3 || data.data[12] !== 1 || !equal(data.data.subarray(13, 45), OWNER.toBytes()) || !equal(data.data.subarray(DATA_HEADER, DATA_HEADER + this.binary.length), this.binary) || data.data.subarray(DATA_HEADER + this.binary.length).some(x => x !== 0)) throw Error('The deployed code or upgrade authority does not match the approved marketplace.');
    return this.result(programId);
  }
  async verify(programId: string): Promise<DeploymentResult> {await this.ready(); await this.load(); const result = await this.verifyAccount(programId); this.written = this.binary.length; this.update('verified', 'The marketplace code, network, and owner are verified.'); return result;}
  private async chainState(): Promise<ChainState> {
    const s = this.state!;
    const program = await this.account(new PublicKey(s.programId));
    if (program) return {program, buffer: null, missingOffsets: [], writtenBytes: this.binary.length, result: await this.verifyAccount(s.programId)};
    if (s.finalConfirmed) throw Error('A confirmed program is temporarily unavailable from this RPC. It will not be deployed a second time.');
    const buffer = await this.account(new PublicKey(s.bufferId));
    const missingOffsets: number[] = [];
    let writtenBytes = 0;
    if (buffer && (buffer.executable || !buffer.owner.equals(DEPLOYMENT_LOADER) || buffer.data.length !== BUFFER_HEADER + this.binary.length || buffer.data.readUInt32LE(0) !== 1 || buffer.data[4] !== 1 || !equal(buffer.data.subarray(5, BUFFER_HEADER), OWNER.toBytes()))) throw Error('The saved upload account has unexpected code, size, or authority.');
    for (let offset = 0; offset < this.binary.length; offset += DEPLOYMENT_WRITE_BYTES) {
      const expected = this.binary.subarray(offset, Math.min(offset + DEPLOYMENT_WRITE_BYTES, this.binary.length));
      const actual = buffer?.data.subarray(BUFFER_HEADER + offset, BUFFER_HEADER + offset + expected.length);
      if (actual && equal(actual, expected)) writtenBytes += expected.length;
      else {
        // Old 900-byte writes can end inside a new 700-byte range. Rewriting
        // matching bytes is idempotent; any differing nonzero byte still stops
        // recovery rather than concealing a corrupt or unrelated upload.
        if (actual?.some((x, index) => x !== 0 && x !== expected[index])) throw Error(`The saved upload contains unexpected bytes at offset ${offset}. It will not be silently overwritten.`);
        missingOffsets.push(offset);
      }
    }
    this.written = writtenBytes;
    return {buffer, program: null, missingOffsets, writtenBytes};
  }
  async inspect(): Promise<DeploymentInspection> {
    await this.ready(); await this.load();
    if (!this.state) return {stage: 'new', writtenBytes: 0, totalBytes: this.binary.length, pendingTransactions: 0};
    const view = await this.chainState();
    return {stage: view.result ? 'verified' : this.state.pending.length ? 'pending' : 'uploading', bufferId: this.state.bufferId, programId: this.state.programId, writtenBytes: view.writtenBytes, totalBytes: this.binary.length, pendingTransactions: this.state.pending.length, result: view.result};
  }
  async checkNextSimulation(): Promise<void> {
    if (this.running) throw Error('Pause the active deployment before checking the next step.');
    await this.ready(); await this.load();
    if (!this.state) throw Error('No saved deployment is available to check. Review the deployment cost first.');
    const s = this.state;
    // This check is read-only: unresolved receipts are never broadcast,
    // confirmed, removed or replaced, and no checkpoint is created or saved.
    if (s.pending.length) throw Error('A saved transaction is unresolved. Check its result before simulating another deployment step.');
    const view = await this.chainState();
    if (view.result) return;
    let action: Action;
    if (!view.buffer) action = {kind: 'buffer', rentLamports: (await this.rents()).buffer};
    else if (view.missingOffsets.length) action = {kind: 'write', offset: view.missingOffsets[0], writeLength: Math.min(DEPLOYMENT_WRITE_BYTES, this.binary.length - view.missingOffsets[0]), rentLamports: 0};
    else action = {kind: 'deploy', rentLamports: (await this.rents()).program};
    const priority = selectPriorityMicroLamports(await this.rpc(this.connection.getRecentPrioritizationFees({lockedWritableAccounts: [OWNER, new PublicKey(s.bufferId)]})));
    const latest = await this.rpc(this.connection.getLatestBlockhash({commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}));
    const transaction = transactionFor(s, action, this.binary, latest.blockhash, priority);
    if (transaction.serialize().length > 1232) throw Error('The deployment packet is too large.');
    await this.fee(transaction);
    const result = await this.rpc(this.connection.simulateTransaction(transaction, {sigVerify: false, replaceRecentBlockhash: false, commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}));
    if (result.value.err) throw simulationFailure('before-wallet', s, action, transaction, priority, result);
  }
  private async fee(tx: VersionedTransaction): Promise<number> {
    const response = await this.rpc(this.connection.getFeeForMessage(tx.message, COMMITMENT));
    if (response.value === null || response.value <= 0) throw Error('The current network fee is unavailable.');
    return integer(response.value, 'network fee');
  }
  private async rents() {
    const [buffer, program, data] = await Promise.all([BUFFER_HEADER + this.binary.length, PROGRAM_HEADER, DATA_HEADER + this.binary.length].map(size => this.rpc(this.connection.getMinimumBalanceForRentExemption(size, COMMITMENT))));
    // web3.js returns zero after some RPC errors; zero is not a rent estimate.
    if (buffer <= 0 || program <= 0 || data <= 0) throw Error('The account storage deposit estimate is unavailable. Try the RPC again before signing.');
    return {buffer: integer(buffer, 'buffer deposit'), program: integer(program, 'program deposit'), data: integer(data, 'program-data deposit')};
  }
  private async estimateLoaded(): Promise<DeploymentEstimate> {
    const s = this.state!, view = await this.chainState();
    const base = {writtenBytes: view.writtenBytes, totalBytes: this.binary.length, pendingTransactions: s.pending.length, programId: s.programId, bufferId: s.bufferId};
    if (view.result) return {...base, requiredLamports: 0, remainingNetworkFeesLamports: 0, bufferRentLamports: 0, programRentLamports: 0, programDataRentLamports: 0, remainingTransactions: 0};
    const rent = await this.rents(), recent = await this.rpc(this.connection.getLatestBlockhash({commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}));
    const actions: Action[] = [...(!view.buffer ? [{kind: 'buffer' as const, rentLamports: rent.buffer}] : []), ...(view.missingOffsets.length ? [{kind: 'write' as const, offset: view.missingOffsets[0], writeLength: Math.min(DEPLOYMENT_WRITE_BYTES, this.binary.length - view.missingOffsets[0]), rentLamports: 0}] : []), {kind: 'deploy', rentLamports: rent.program}];
    const fees = await Promise.all(actions.map(action => this.fee(transactionFor(s, action, this.binary, recent.blockhash, MAX_PRIORITY))));
    const networkFees = sum(...actions.map((action, i) => fees[i] * (action.kind === 'write' ? view.missingOffsets.length : 1)), ...s.pending.map(p => p.feeLamports));
    const bufferRent = view.buffer ? 0 : rent.buffer;
    return {...base, requiredLamports: sum(bufferRent, rent.program, rent.data, networkFees), remainingNetworkFeesLamports: networkFees, bufferRentLamports: bufferRent, programRentLamports: rent.program, programDataRentLamports: rent.data, remainingTransactions: (view.buffer ? 0 : 1) + view.missingOffsets.length + 1};
  }
  async estimate(): Promise<DeploymentEstimate> {await this.ready(); await this.load(true); return this.estimateLoaded();}
  pause() {this.paused = true;}
  private checkPaused() {if (this.paused) {this.update('paused', 'Deployment paused with its recovery record saved.'); throw new DeploymentPausedError();}}
  private async signerReady(signer: DeploymentSigner) {await signer.assertCurrentAccount(); if (!signer.publicKey.equals(OWNER)) throw Error('Connect the approved developer, treasury, and admin wallet to deploy.');}

  // A finalized height beyond expiry plus a second sufficiently fresh status
  // read is required before discarding a null receipt. Account reconciliation
  // then decides which work remains; a missing response never starts a new ID.
  private async settlePending(): Promise<boolean> {
    const s = this.state!;
    if (!s.pending.length) return true;
    let result = await this.rpc(this.connection.getSignatureStatuses(s.pending.map(p => p.signature), {searchTransactionHistory: true}));
    if (result.value.length !== s.pending.length) throw Error('The RPC returned incomplete deployment receipts.');
    let finalizedHeight = -1, finalizedSlot = -1;
    if (result.value.some(x => x === null)) {
      const epoch = await this.rpc(this.connection.getEpochInfo('finalized'));
      finalizedHeight = integer(epoch.blockHeight!, 'finalized block height'); finalizedSlot = integer(epoch.absoluteSlot, 'finalized slot');
      result = await this.rpc(this.connection.getSignatureStatuses(s.pending.map(p => p.signature), {searchTransactionHistory: true}));
      if (result.value.length !== s.pending.length) throw Error('The RPC returned incomplete deployment receipts.');
    }
    const resultSlot = integer(result.context.slot, 'receipt context');
    const remaining: Pending[] = []; let failed = false;
    for (let i = 0; i < s.pending.length; i++) {
      const p = s.pending[i], receipt = result.value[i];
      if (receipt?.confirmationStatus === 'confirmed' || receipt?.confirmationStatus === 'finalized') {
        // Signature-status context is the node's processed tip. Only the
        // confirmed receipt slot is a valid floor for confirmed account reads.
        s.minimumContextSlot = Math.max(s.minimumContextSlot, integer(receipt.slot, 'confirmed transaction slot'));
        this.settledOutcomes.set(p.signature, receipt.err ? 'failed' : 'confirmed');
        if (receipt.err) failed = true;
        else if (p.kind === 'deploy') {s.finalSignature = p.signature; s.finalConfirmed = true;}
      } else if (!receipt && finalizedHeight > p.lastValidBlockHeight && resultSlot >= finalizedSlot) {s.minimumContextSlot = Math.max(s.minimumContextSlot, finalizedSlot); this.settledOutcomes.set(p.signature, 'expired');}
      else remaining.push(p);
    }
    // Reconcile before forgetting any receipt, including a confirmed final one.
    await this.chainState();
    s.pending = remaining;
    this.save();
    if (failed) throw Error('A deployment transaction failed on Solana. Its result is saved; review the wallet receipt before resuming.');
    return !remaining.length;
  }
  private async confirmPending() {
    const deadline = Date.now() + CONFIRM_MS;
    let lastBroadcast = 0;
    while (Date.now() < deadline) {
      if (await withSolanaTimeout(this.settlePending(), Math.max(1, deadline - Date.now()))) return;
      const height = integer(await this.rpc(this.connection.getBlockHeight(COMMITMENT)), 'current block height');
      if (Date.now() - lastBroadcast >= 8_000) {
        lastBroadcast = Date.now();
        // Only the already-approved signature is retried. A new blockhash is
        // never substituted into a signed or unresolved transaction.
        const pending = this.state!.pending.filter(p => height <= p.lastValidBlockHeight);
        await this.broadcastSaved(pending);
      }
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    throw new DeploymentPausedError('Confirmation is still pending. The signed receipts are saved; resume will check them before any new approval.');
  }
  private async broadcast(p: Pending) {
    const result = await this.rpc(this.connection.sendRawTransaction(Buffer.from(p.raw, 'base64'), {skipPreflight: false, preflightCommitment: COMMITMENT, maxRetries: 3, minContextSlot: this.state!.minimumContextSlot}));
    if (result !== p.signature) throw Error('The RPC returned a different deployment signature. The signed receipt is preserved.');
  }
  private async broadcastSaved(pending: Pending[]) {
    const outcomes = await Promise.allSettled(pending.map(p => this.broadcast(p)));
    // One rejected relay request does not establish what happened to the rest
    // of a signed batch. Retain EVERY receipt and let normal reconciliation
    // determine its outcome on resume. Network reply loss still follows the
    // existing confirmation/rebroadcast path with the exact approved packet.
    for (const outcome of outcomes) if (outcome.status === 'rejected' && outcome.reason instanceof DeploymentRpcError) throw outcome.reason;
  }
  private async send(actions: Action[], signer: DeploymentSigner, budget: {maximum: number; reserved: number}, dataRent: number) {
    if (!actions.length || actions.length > 5 || actions.length > 1 && actions.some(a => a.kind !== 'write')) throw Error('Invalid deployment transaction batch.');
    const s = this.state!;
    if (s.pending.length) throw Error('Resolve saved deployment transactions before signing another batch.');
    this.checkPaused(); await this.signerReady(signer); await this.ready();
    const priority = selectPriorityMicroLamports(await this.rpc(this.connection.getRecentPrioritizationFees({lockedWritableAccounts: [OWNER, new PublicKey(s.bufferId)]})));
    const latest = await this.rpc(this.connection.getLatestBlockhash({commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}));
    const txs = actions.map(action => transactionFor(s, action, this.binary, latest.blockhash, priority));
    for (const tx of txs) if (tx.serialize().length > 1232) throw Error('The deployment packet is too large.');
    const fees = await Promise.all(txs.map(tx => this.fee(tx)));
    const batchCost = sum(...actions.map((a,i) => sum(a.rentLamports, fees[i], a.kind === 'deploy' ? dataRent : 0)));
    if (sum(budget.reserved, batchCost) > budget.maximum) throw Error('The deployment cost exceeds your approved limit. Review a new estimate before continuing.');
    const simulations = await Promise.all(txs.map(tx => this.rpc(this.connection.simulateTransaction(tx, {sigVerify: false, replaceRecentBlockhash: false, commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}))));
    for (let i = 0; i < simulations.length; i++) if (simulations[i].value.err) throw simulationFailure('before-wallet', s, actions[i], txs[i], priority, simulations[i]);
    this.checkPaused();
    const snapshots = txs.map(tx => Uint8Array.from(tx.message.serialize()));
    this.update('signing', actions.length > 1 ? `Review ${actions.length} upload transactions in your wallet.` : actions[0].kind === 'buffer' ? 'Review creation of your program upload account.' : actions[0].kind === 'deploy' ? 'Review the final marketplace deployment.' : 'Review the next upload transaction.');
    const signed = await withSolanaTimeout(signer.signTransactions(txs), 120_000);
    await this.signerReady(signer);
    if (signed.length !== txs.length) throw Error('The wallet returned an incomplete deployment batch.');
    let guarded = false;
    for (let i = 0; i < signed.length; i++) guarded = await checkSignature(signed[i], snapshots[i]) || guarded;
    if (guarded) s.walletAssertions = true;
    else if (s.walletAssertions === undefined) s.walletAssertions = false;
    // The approved returned messages can contain read-only wallet assertions.
    // Check their actual fee and simulate those signed bytes, not only the
    // unsigned originals, before any recoverable packet is persisted or sent.
    const signedFees = await Promise.all(signed.map(tx => this.fee(tx)));
    const signedBatchCost = sum(...actions.map((action, index) => sum(action.rentLamports, signedFees[index], action.kind === 'deploy' ? dataRent : 0)));
    if (sum(budget.reserved, signedBatchCost) > budget.maximum) throw Error('The signed deployment cost exceeds your approved limit. Nothing new was submitted. Review a new estimate.');
    const signedSimulations = await Promise.all(signed.map(tx => this.rpc(this.connection.simulateTransaction(tx, {sigVerify: true, replaceRecentBlockhash: false, commitment: COMMITMENT, minContextSlot: s.minimumContextSlot}))));
    for (let i = 0; i < signedSimulations.length; i++) if (signedSimulations[i].value.err) throw simulationFailure('after-wallet', s, actions[i], signed[i], priority, signedSimulations[i]);
    await this.signerReady(signer);
    if (integer(await this.rpc(this.connection.getBlockHeight(COMMITMENT)), 'current block height') > latest.lastValidBlockHeight) throw new DeploymentPausedError('Wallet approval expired before submission. No new transaction was sent; resume for fresh approvals.');
    await this.signerReady(signer);
    this.checkPaused();
    s.pending = signed.map((tx,i) => ({...actions[i], signature: encodeSolanaSignature(tx.signatures[0]), raw: Buffer.from(tx.serialize()).toString('base64'), blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight, priority, feeLamports: signedFees[i]}));
    if (actions[0].kind === 'deploy') s.finalSignature = s.pending[0].signature;
    this.save(); // Persist EVERY approved packet before ANY packet is sent.
    const batchSignatures = s.pending.map(receipt => receipt.signature);
    budget.reserved = sum(budget.reserved, signedBatchCost);
    this.update('confirming', 'Checking the signed deployment transactions on Solana.', s.pending[0].signature);
    await this.broadcastSaved(s.pending);
    await this.confirmPending();
    // A finalized expiry settles a receipt but does not complete its action.
    // In particular, never proceed to Write after buffer creation expired.
    // Keep the saved seeded addresses and require a fresh, reviewed resume.
    if (batchSignatures.some(signature => this.settledOutcomes.get(signature) === 'expired')) {
      const step = actions[0].kind === 'buffer' ? 'upload-account' : actions[0].kind === 'deploy' ? 'final deployment' : 'upload';
      throw new DeploymentPausedError(`The ${step} transaction expired without confirmation. No further transaction was sent. Resume will check the same saved accounts before requesting another approval.`);
    }
  }
  async run(signer: DeploymentSigner, approvedMaxLamports: number): Promise<DeploymentResult> {
    if (this.running) throw Error('This deployment is already running.');
    this.running = true; this.paused = false; this.settledOutcomes.clear();
    try {
      integer(approvedMaxLamports, 'approved deployment limit'); if (!approvedMaxLamports) throw Error('Review and approve the deployment estimate first.');
      await this.signerReady(signer); await this.ready(); await this.load(true);
      this.update('checking', 'Checking saved receipts and the existing upload before continuing.');
      const before = await this.chainState();
      const rent = await this.rents();
      const pendingCosts = this.state!.pending.map(p => ({signature: p.signature, cost: sum(p.feeLamports, p.kind === 'buffer' && !before.buffer ? p.rentLamports : p.kind === 'deploy' && !before.result ? sum(p.rentLamports, rent.data) : 0)}));
      const budget = {maximum: approvedMaxLamports, reserved: sum(...pendingCosts.map(p => p.cost))};
      if (budget.reserved > budget.maximum) throw Error('Your approved limit does not cover the unresolved deployment transactions.');
      if (this.state!.pending.length) {this.update('confirming', 'Checking the saved transaction receipts before asking for any new signatures.', this.state!.pending[0].signature); await this.confirmPending();}
      // Finalized-expired packets cannot spend later, so their reserve can be
      // released before a fresh approval is requested for the same saved IDs.
      for (const pending of pendingCosts) if (this.settledOutcomes.get(pending.signature) === 'expired') budget.reserved -= pending.cost;
      let view = await this.chainState();
      if (view.result) {this.written = this.binary.length; this.update('verified', 'Marketplace deployed and verified.'); return view.result;}
      this.checkPaused();
      const estimate = await this.estimateLoaded();
      if (sum(budget.reserved, estimate.requiredLamports) > budget.maximum) throw Error('The remaining cost exceeds the approved limit. Refresh the estimate before resuming.');
      if (integer(await this.rpc(this.connection.getBalance(OWNER, {commitment: COMMITMENT, minContextSlot: this.state!.minimumContextSlot})), 'wallet balance') < estimate.requiredLamports) throw Error('Your admin wallet needs more SOL for the displayed deployment reserve.');
      if (!view.buffer) await this.send([{kind: 'buffer', rentLamports: rent.buffer}], signer, budget, rent.data);
      view = await this.chainState();
      if (!view.buffer && !view.result) throw new DeploymentPausedError('The upload account is not visible from the RPC yet. No upload transaction was sent. Resume will check the same saved account.');
      while (view.missingOffsets.length) {
        this.checkPaused();
        this.update('uploading', `Program upload: ${Math.floor(view.writtenBytes / this.binary.length * 100)}%. Your verified progress is saved.`);
        // Wallet balance assertions can depend on the previous transaction's
        // fee. Prepare the next guarded write only after that state confirms.
        // An older checkpoint with no mode starts with one write as well, so
        // guard behavior is known before any multi-transaction wallet request.
        const previousWrittenBytes = view.writtenBytes;
        await this.send(view.missingOffsets.slice(0, this.state!.walletAssertions === false ? 5 : 1).map(offset => ({kind: 'write', offset, writeLength: Math.min(DEPLOYMENT_WRITE_BYTES, this.binary.length - offset), rentLamports: 0})), signer, budget, rent.data);
        view = await this.chainState();
        if (!view.result && (!view.buffer || view.writtenBytes <= previousWrittenBytes)) throw new DeploymentPausedError('The confirmed upload bytes are not visible from the RPC yet. Deployment paused before requesting another approval; resume will check the saved upload.');
      }
      this.checkPaused();
      if (!view.buffer || await hash(view.buffer.data.subarray(BUFFER_HEADER)) !== DEPLOYMENT_PROGRAM_SHA256) throw Error('The completed upload does not match the approved program. It will not be deployed.');
      await this.send([{kind: 'deploy', rentLamports: rent.program}], signer, budget, rent.data);
      const result = await this.verifyAccount(this.state!.programId);
      this.written = this.binary.length; this.update('verified', 'Marketplace deployed and verified.');
      return result;
    } finally {this.running = false;}
  }
}
