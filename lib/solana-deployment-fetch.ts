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
    return start.then(() => fetch(input, {...init, signal}));
  };
}
