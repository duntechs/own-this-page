import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.sites-runtime/deployment-fetch-tests');
await build({configFile: false, root, publicDir: false, logLevel: 'silent', build: {ssr: true, outDir: out, emptyOutDir: true, rollupOptions: {input: path.join(root, 'lib/solana-deployment-fetch.ts'), output: {entryFileNames: 'fetch.mjs'}}}});
const {createDeploymentRpcFetch} = await import(pathToFileURL(path.join(out, 'fetch.mjs')).href);
const originalFetch = globalThis.fetch;
const body = (method, id) => JSON.stringify({jsonrpc: '2.0', id, method, params: method === 'sendTransaction' ? [`signed-packet-${id}`, {encoding: 'base64'}] : []});
const request = (queuedFetch, method, id, extra = {}) => queuedFetch('https://rpc.invalid/api/rpc', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: body(method, id), ...extra});
const ok = () => new Response('{}', {status: 200, headers: {'Content-Type': 'application/json'}});
const deadline = (promise, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(`${label} blocked the queue.`)), 6_000);
  promise.then(value => {clearTimeout(timer); resolve(value);}, error => {clearTimeout(timer); reject(error);});
});
let count = 0;
async function check(name, run) {await run(); console.log(`PASS ${++count} ${name}`);}

try {
  await check('read dispatches remain FIFO and spaced even while an earlier response is unresolved', async () => {
    const starts = []; let releaseFirst;
    globalThis.fetch = async (url, init) => {
      const payload = JSON.parse(init.body);
      starts.push({id: payload.id, at: Date.now()});
      assert.equal(url, 'https://rpc.invalid/api/rpc');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert(init.signal instanceof AbortSignal);
      if (payload.id === 1) return new Promise(resolve => {releaseFirst = () => resolve(ok());});
      return ok();
    };
    const queued = createDeploymentRpcFetch(), first = request(queued, 'getAccountInfo', 1);
    await deadline(Promise.all([request(queued, 'getAccountInfo', 2), request(queued, 'getAccountInfo', 3), request(queued, 'getAccountInfo', 4)]), 'Unresolved response');
    assert.deepEqual(starts.map(x => x.id), [1, 2, 3, 4]);
    for (let i = 1; i < starts.length; i++) assert(starts[i].at - starts[i - 1].at >= 260, 'RPC reads started too close together');
    releaseFirst(); await first;
  });

  await check('a failed network request cannot poison later queue entries', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {const id = JSON.parse(init.body).id; seen.push(id); if (id === 1) throw Error('Simulated network failure'); return ok();};
    const queued = createDeploymentRpcFetch();
    const rejected = assert.rejects(request(queued, 'getBlockHeight', 1), /Simulated network failure/);
    await deadline(Promise.all([rejected, request(queued, 'getBlockHeight', 2)]), 'Failed response');
    assert.deepEqual(seen, [1, 2]);
  });

  await check('aborted queued and already-aborted requests never dispatch and do not block the next request', async () => {
    const seen = [];
    globalThis.fetch = async (_url, init) => {seen.push(JSON.parse(init.body).id); return ok();};
    const queued = createDeploymentRpcFetch(); await request(queued, 'getBlockHeight', 1);
    const controller = new AbortController();
    const cancelled = assert.rejects(request(queued, 'getBlockHeight', 2, {signal: controller.signal}), error => error.name === 'AbortError');
    setTimeout(() => controller.abort(), 20);
    const already = new AbortController(); already.abort();
    const preCancelled = assert.rejects(request(queued, 'getBlockHeight', 3, {signal: already.signal}), error => error.name === 'AbortError');
    await deadline(Promise.all([cancelled, preCancelled, request(queued, 'getBlockHeight', 4)]), 'Aborted request');
    assert.deepEqual(seen, [1, 4]);
  });

  await check('signed send requests retain exact packet bodies and obey the slower send limit between reads', async () => {
    const starts = [];
    globalThis.fetch = async (_url, init) => {
      const payload = JSON.parse(init.body);
      starts.push({id: payload.id, method: payload.method, at: Date.now()});
      assert.equal(init.body, body(payload.method, payload.id), 'Signed transaction request was changed');
      return ok();
    };
    const queued = createDeploymentRpcFetch();
    await deadline(Promise.all([
      request(queued, 'sendTransaction', 1), request(queued, 'getSignatureStatuses', 2),
      request(queued, 'sendTransaction', 3), request(queued, 'getBlockHeight', 4), request(queued, 'sendTransaction', 5),
    ]), 'Signed send pacing');
    assert.deepEqual(starts.map(x => x.id), [1, 2, 3, 4, 5]);
    for (let i = 1; i < starts.length; i++) assert(starts[i].at - starts[i - 1].at >= 260, 'RPC dispatch spacing was bypassed');
    const sends = starts.filter(x => x.method === 'sendTransaction');
    for (let i = 1; i < sends.length; i++) assert(sends[i].at - sends[i - 1].at >= 1_125, 'Signed sends started too close together');
  });
} finally {globalThis.fetch = originalFetch;}
console.log(`Deployment fetch: ${count} checks passed; only mocked fetch was used.`);
