type PreflightTransactionError = string | {InstructionError: [number, string | {Custom: number}]};
export type DeploymentPreflightReport = {err: PreflightTransactionError; unitsConsumed: number | null; contextSlot: number | null};

// The same reviewed protocol names used by simulation diagnostics. Never use
// a provider's arbitrary error string as a user-visible or shareable value.
const PREFLIGHT_ERROR_IDENTIFIERS = new Set(`AccountInUse AccountLoadedTwice AccountNotFound ProgramAccountNotFound InsufficientFundsForFee InvalidAccountForFee AlreadyProcessed BlockhashNotFound CallChainTooDeep MissingSignatureForFee InvalidAccountIndex SignatureFailure InvalidProgramForExecution SanitizeFailure ClusterMaintenance AccountBorrowOutstanding WouldExceedMaxBlockCostLimit UnsupportedVersion InvalidWritableAccount WouldExceedMaxAccountCostLimit WouldExceedAccountDataBlockLimit TooManyAccountLocks AddressLookupTableNotFound InvalidAddressLookupTableOwner InvalidAddressLookupTableIndex InvalidRentPayingAccount WouldExceedMaxVoteCostLimit WouldExceedAccountDataTotalLimit MaxLoadedAccountsDataSizeExceeded InvalidLoadedAccountsDataSizeLimit ResanitizationNeeded UnbalancedTransaction ProgramCacheHitMaxLimit CommitCancelled GenericError InvalidArgument InvalidInstructionData InvalidAccountData AccountDataTooSmall InsufficientFunds IncorrectProgramId MissingRequiredSignature AccountAlreadyInitialized UninitializedAccount UnbalancedInstruction ModifiedProgramId ExternalAccountLamportSpend ExternalAccountDataModified ReadonlyLamportChange ReadonlyDataModified DuplicateAccountIndex ExecutableModified RentEpochModified NotEnoughAccountKeys AccountDataSizeChanged AccountNotExecutable AccountBorrowFailed DuplicateAccountOutOfSync Custom InvalidError ExecutableDataModified ExecutableLamportChange ExecutableAccountNotRentExempt UnsupportedProgramId CallDepth MissingAccount ReentrancyNotAllowed MaxSeedLengthExceeded InvalidSeeds InvalidRealloc ComputationalBudgetExceeded PrivilegeEscalation ProgramEnvironmentSetupFailure ProgramFailedToComplete ProgramFailedToCompile Immutable IncorrectAuthority AccountNotRentExempt InvalidAccountOwner ArithmeticOverflow UnsupportedSysvar IllegalOwner MaxAccountsDataAllocationsExceeded MaxAccountsExceeded MaxInstructionTraceLengthExceeded BuiltinProgramsMustConsumeComputeUnits`.split(' '));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedUnsigned = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : null;
const errorIdentifier = (value: unknown): value is string => typeof value === 'string' && PREFLIGHT_ERROR_IDENTIFIERS.has(value);

// Called independently by the Worker before returning a provider error and by
// the browser before displaying it. Keep the standard err shape so neither
// boundary has to trust a preformatted diagnostic from the other.
export function sanitizeDeploymentPreflight(value: unknown): DeploymentPreflightReport | undefined {
  if (!record(value) || !Object.hasOwn(value, 'err')) return undefined;
  const failure = value.err;
  let err: PreflightTransactionError = 'UnrecognizedPreflightError';
  if (errorIdentifier(failure)) err = failure;
  else if (record(failure) && Object.keys(failure).length === 1 && Array.isArray(failure.InstructionError) && failure.InstructionError.length === 2) {
    const [index, detail] = failure.InstructionError;
    if (boundedUnsigned(index, 255) !== null) {
      if (errorIdentifier(detail)) err = {InstructionError: [index as number, detail]};
      else if (record(detail) && Object.keys(detail).length === 1 && boundedUnsigned(detail.Custom, 0xffff_ffff) !== null) err = {InstructionError: [index as number, {Custom: detail.Custom as number}]};
    }
  }
  return {err, unitsConsumed: boundedUnsigned(value.unitsConsumed), contextSlot: boundedUnsigned(value.contextSlot) ?? (record(value.context) ? boundedUnsigned(value.context.slot) : null)};
}

export type DeploymentRpcReport = {
  diagnosticVersion: 'otp-rpc-1';
  method: 'sendTransaction';
  httpStatus: number | null;
  rpcCode: number | null;
  preflight?: DeploymentPreflightReport;
};

// Only bounded protocol values enter a shareable submission diagnostic. In
// particular, neither upstream messages nor request URLs/packets are retained.
export class DeploymentRpcError extends Error {
  readonly report: DeploymentRpcReport;
  constructor(httpStatus: number | null, rpcCode: number | null, preflightData?: unknown) {
    const status = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    const code = typeof rpcCode === 'number' && Number.isInteger(rpcCode) && rpcCode >= -0x8000_0000 && rpcCode <= 0x7fff_ffff ? rpcCode : null;
    const preflight = code === -32002 ? sanitizeDeploymentPreflight(preflightData) : undefined;
    const problem = status === 200 && code === -32002 ? preflight?.err === 'BlockhashNotFound'
      ? "Solana could not find this transaction's recent blockhash during preflight."
      : 'Solana rejected a deployment transaction during preflight.'
      : `A deployment submission returned an RPC error${status === null ? '' : ` (HTTP ${status})`}.`;
    super(`${problem} All signed receipts are saved; resume will check their status before any new approval.`);
    this.name = 'DeploymentRpcError';
    this.report = {diagnosticVersion: 'otp-rpc-1', method: 'sendTransaction', httpStatus: status, rpcCode: code, ...(preflight ? {preflight} : {})};
  }
}

async function submissionError(response: Response): Promise<{code: number; preflight?: DeploymentPreflightReport} | null> {
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  try {
    // A successful signature or JSON-RPC error envelope is small. Bound this
    // diagnostic read even if a broken upstream returns a large HTML page.
    const decoder = new TextDecoder(); let text = '', length = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 16_384) return null;
      text += decoder.decode(chunk.value, {stream: true});
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !('error' in value)) return null;
    const error = value.error;
    if (!error || typeof error !== 'object' || Array.isArray(error) || !('code' in error)) return null;
    if (typeof error.code !== 'number' || !Number.isInteger(error.code) || error.code < -0x8000_0000 || error.code > 0x7fff_ffff) return null;
    const preflight = error.code === -32002 && 'data' in error ? sanitizeDeploymentPreflight(error.data) : undefined;
    return {code: error.code, ...(preflight ? {preflight} : {})};
  } catch {return null;}
  finally {
    // Cancelling one tee branch can wait for the untouched original response;
    // do not make the caller consume that original before returning it.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// The Helius free RPC has a lower transaction-send allowance than its read
// allowance. Queue requests before dispatch so wallet-approved upload batches
// do not create an avoidable rate-limit pause. Deadlines include queue time.
export function createDeploymentRpcFetch(): typeof fetch {
  let queue: Promise<void> = Promise.resolve();
  let lastStart = 0, lastSend = 0;
  return (input, init) => {
    const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]);
    let isSend = false;
    try {isSend = typeof init?.body === 'string' && JSON.parse(init.body).method === 'sendTransaction';} catch { /* The relay rejects malformed requests. */ }
    const start = queue.then(async () => {
      const delay = Math.max(0, lastStart + 275 - Date.now(), isSend ? lastSend + 1_150 - Date.now() : 0);
      if (delay) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {signal.removeEventListener('abort', abort); resolve();}, delay);
        const abort = () => {clearTimeout(timer); reject(signal.reason);};
        signal.addEventListener('abort', abort, {once: true});
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
      lastStart = Date.now();
      if (isSend) lastSend = lastStart;
    });
    queue = start.catch(() => {});
    return start.then(async () => {
      const response = await fetch(input, {...init, signal});
      if (isSend) {
        const failure = await submissionError(response);
        if (!response.ok || failure !== null) throw new DeploymentRpcError(response.status, failure?.code ?? null, failure?.preflight);
      }
      return response;
    });
  };
}
