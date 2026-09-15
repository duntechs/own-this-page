export type DeploymentRpcReport = {
  diagnosticVersion: 'otp-rpc-1';
  method: 'sendTransaction';
  httpStatus: number | null;
  rpcCode: number | null;
};

// Only bounded protocol numbers enter a shareable submission diagnostic. In
// particular, neither upstream messages nor request URLs/packets are retained.
export class DeploymentRpcError extends Error {
  readonly report: DeploymentRpcReport;
  constructor(httpStatus: number | null, rpcCode: number | null) {
    const status = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
    const code = typeof rpcCode === 'number' && Number.isInteger(rpcCode) && rpcCode >= -0x8000_0000 && rpcCode <= 0x7fff_ffff ? rpcCode : null;
    super(`A deployment submission returned an RPC error${status === null ? '' : ` (HTTP ${status})`}. All signed receipts are saved; resume will check their status before any new approval.`);
    this.name = 'DeploymentRpcError';
    this.report = {diagnosticVersion: 'otp-rpc-1', method: 'sendTransaction', httpStatus: status, rpcCode: code};
  }
}

async function submissionErrorCode(response: Response): Promise<number | null> {
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
    return typeof error.code === 'number' && Number.isInteger(error.code) && error.code >= -0x8000_0000 && error.code <= 0x7fff_ffff ? error.code : null;
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
        const code = await submissionErrorCode(response);
        if (!response.ok || code !== null) throw new DeploymentRpcError(response.status, code);
      }
      return response;
    });
  };
}
