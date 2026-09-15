import assert from 'node:assert/strict';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import {build} from 'vite';
import {Connection} from '@solana/web3.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.join(root, '.sites-runtime/deployment-fetch-tests');
await build({configFile: false, root, publicDir: false, logLevel: 'silent', build: {ssr: true, outDir: out, emptyOutDir: true, rollupOptions: {input: path.join(root, 'lib/solana-deployment-fetch.ts'), output: {entryFileNames: 'fetch.mjs'}}}});
const {createDeploymentRpcFetch, DeploymentRpcError} = await import(pathToFileURL(path.join(out, 'fetch.mjs')).href);
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

  await check('HTTP and JSON-RPC submission errors survive web3.js with only bounded shareable protocol fields', async () => {
    for (const [status, code] of [[400,-32600],[503,-32002],[200,-32003],[400,null]]) {
      globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code,message:'api-key=private-secret',data:'signed-packet-private'}}), {status});
      const connection = new Connection('https://rpc.invalid/api/rpc?api-key=never-share', {fetch:createDeploymentRpcFetch(),disableRetryOnRateLimit:true});
      await assert.rejects(() => connection.sendRawTransaction(Uint8Array.of(1,2,3), {skipPreflight:false}), error => {
        assert(error instanceof DeploymentRpcError);
        assert.deepEqual(error.report,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:status,rpcCode:code});
        const exposed = error.message + JSON.stringify(error.report);
        assert(exposed.length < 500);
        for (const secret of ['private-secret','signed-packet-private','never-share','api-key','rpc.invalid']) assert(!exposed.includes(secret));
        return true;
      });
    }
  });

  await check('preflight reports distinguish missing blockhashes and instruction errors and independently redact unsafe details', async () => {
    for(const [err,expected] of [
      ['BlockhashNotFound','BlockhashNotFound'],
      [{InstructionError:[3,{Custom:41}]},{InstructionError:[3,{Custom:41}]}],
      [{InstructionError:[2,'ComputationalBudgetExceeded']},{InstructionError:[2,'ComputationalBudgetExceeded']}],
      ['arbitrarySecret','UnrecognizedPreflightError'],
      [{InstructionError:[2,{Custom:-1}]},'UnrecognizedPreflightError'],
      [{InstructionError:[2,'arbitrarySecret']},'UnrecognizedPreflightError'],
      [{InstructionError:[2,{BorshIoError:'arbitrarySecret'}]},'UnrecognizedPreflightError'],
    ]){
      globalThis.fetch=async()=>new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32002,message:'api-key=private-secret',data:{err,unitsConsumed:1234,contextSlot:5678,logs:['arbitrarySecret'],raw:'signed-packet-private'}}}),{status:200});
      const connection=new Connection('https://rpc.invalid/api/rpc',{fetch:createDeploymentRpcFetch(),disableRetryOnRateLimit:true});
      await assert.rejects(()=>connection.sendRawTransaction(Uint8Array.of(1,2,3),{skipPreflight:false}),error=>{
        assert(error instanceof DeploymentRpcError);
        assert.deepEqual(error.report,{diagnosticVersion:'otp-rpc-1',method:'sendTransaction',httpStatus:200,rpcCode:-32002,preflight:{err:expected,unitsConsumed:1234,contextSlot:5678}});
        assert.match(error.message,err==='BlockhashNotFound'?/recent blockhash during preflight/:/rejected a deployment transaction during preflight/);
        const exposed=JSON.stringify(error.report)+error.message;for(const secret of ['arbitrarySecret','private-secret','signed-packet-private','logs'])assert(!exposed.includes(secret));return true;
      });
    }
    const bounded=new DeploymentRpcError(200,-32002,{err:'BlockhashNotFound',unitsConsumed:Infinity,context:{slot:-1}});
    assert.deepEqual(bounded.report.preflight,{err:'BlockhashNotFound',unitsConsumed:null,contextSlot:null});
    assert.equal(new DeploymentRpcError(200,-32600,{err:'BlockhashNotFound'}).report.preflight,undefined);
  });

  await check('cloned response inspection leaves successful sends and non-send responses readable and unchanged', async () => {
    const responseBody = JSON.stringify({jsonrpc:'2.0',id:1,result:'unchanged-signature'});
    globalThis.fetch = async () => new Response(responseBody,{status:200});
    assert.equal(await (await request(createDeploymentRpcFetch(),'sendTransaction',1)).text(),responseBody);
    const readError = JSON.stringify({error:{code:-32000,message:'read error'}});
    globalThis.fetch = async () => new Response(readError,{status:503});
    const read = await request(createDeploymentRpcFetch(),'getSignatureStatuses',2);
    assert.equal(read.status,503);assert.equal(await read.text(),readError);
    for(const code of ['-32000',Number.MAX_SAFE_INTEGER,0.5]) {
      const malformed = JSON.stringify({error:{code,message:'never retained'}});
      globalThis.fetch = async () => new Response(malformed,{status:400});
      await assert.rejects(() => request(createDeploymentRpcFetch(),'sendTransaction',3),error => error instanceof DeploymentRpcError && error.report.rpcCode===null);
    }
    globalThis.fetch = async () => new Response('private-html-response'.repeat(2_000),{status:502});
    await assert.rejects(() => request(createDeploymentRpcFetch(),'sendTransaction',4),error => error instanceof DeploymentRpcError && error.report.httpStatus===502 && error.report.rpcCode===null);
  });
} finally {globalThis.fetch = originalFetch;}
console.log(`Deployment fetch: ${count} checks passed; only mocked fetch was used.`);
