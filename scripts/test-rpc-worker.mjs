import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {Keypair, SystemProgram, TransactionMessage, VersionedTransaction} from '@solana/web3.js';

// Run the actual Worker handler with mocked bindings and upstream fetch. No
// credential or live Solana request is used in these tests.
const imageSource = await readFile(new URL('../worker/images.ts', import.meta.url), 'utf8');
const imageModule = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(imageSource)).toString('base64')}`;
const source = (await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8')).replace("from './images'", `from '${imageModule}'`);
const worker = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
const {handleRequest, heliusEndpoint, validRpcCall, RPC_MAX_REQUEST_BYTES, RPC_MAX_RESPONSE_BYTES} = worker;
const site = 'https://ownthispage.page';
const fakeKey = 'test-only-credential-123456789';
const endpoint = `https://mainnet.helius-rpc.com/?api-key=${fakeKey}`;
const treasury = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';
const sig = '3'.repeat(88);
const b64 = Buffer.alloc(1200, 42).toString('base64');
const genesis = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const call = (method, params = [], id = 1) => ({jsonrpc: '2.0', id, method, params});
const request = (body = call('getGenesisHash'), extras = {}) => new Request(`${site}/api/rpc`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: site, 'CF-Connecting-IP': '192.0.2.1', ...extras}, body: JSON.stringify(body)});
const env = (extra = {}) => ({ASSETS: {fetch: async () => new Response('asset')}, HELIUS_RPC_URL: endpoint, RPC_LIMIT: {limit: async () => ({success: true})}, RPC_SEND_LIMIT: {limit: async () => ({success: true})}, ...extra});
const reply = (result, id = 1) => new Response(JSON.stringify({jsonrpc: '2.0', id, result}), {headers: {'Content-Type': 'application/json'}});
const oldFetch = globalThis.fetch;
let passed = 0;
async function test(name, fn) {await fn(); passed++; console.log(`ok ${passed} - ${name}`);}
const bodyOf = async r => JSON.parse(await r.text());

async function browserRpcClient(fetch) {
  const fetchPath = fileURLToPath(new URL('../lib/solana-deployment-fetch.ts', import.meta.url));
  const entry = fileURLToPath(new URL('../.sites-runtime/rpc-browser-regression.ts', import.meta.url));
  const built = await build({
    configFile: false, publicDir: false, logLevel: 'silent',
    plugins: [{name: 'rpc-browser-fixture', resolveId(id) {if (id === entry) return '\0' + entry;}, load(id) {
      if (id === '\0' + entry) return `export {Connection} from '@solana/web3.js'; export {createDeploymentRpcFetch} from ${JSON.stringify(fetchPath)};`;
    }}],
    build: {write: false, target: 'es2022', minify: false, lib: {entry, name: 'BrowserRpc', formats: ['iife']}},
  });
  const code = (Array.isArray(built) ? built : [built]).flatMap(item => item.output).find(item => item.type === 'chunk').code;
  // Real browser dependency graph and pacing fetch, without Node Buffer or a
  // live network. Browser-origin headers are supplied by the mock transport.
  const context = vm.createContext({fetch, crypto: globalThis.crypto, URL, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView, AbortSignal, AbortController, setTimeout, clearTimeout, setInterval, clearInterval, console});
  vm.runInContext(code, context, {timeout: 10_000});
  assert.equal(vm.runInContext('typeof Buffer', context), 'undefined');
  return context.BrowserRpc;
}
try {
  await test('requires the exact runtime secret and a bounded Helius mainnet URL', async () => {
    assert.equal(heliusEndpoint(endpoint)?.href, endpoint);
    for (const secret of [undefined, '', 'HELIUS_RPC_URL', ` ${endpoint}`, endpoint + '&x=1', endpoint + '&api-key=duplicate', endpoint.replace('mainnet', 'devnet'), endpoint.replace('https:', 'http:'), endpoint.replace('mainnet.helius-rpc.com', '127.0.0.1'), endpoint.replace('mainnet.helius-rpc.com', 'mainnet.helius-rpc.com.evil.example'), endpoint.replace('https://', 'https://user:pass@'), endpoint.replace('/?', '/path?'), endpoint + '#fragment', endpoint.replace('mainnet.helius-rpc.com', 'mainnet.helius-rpc.com:8443')]) assert.equal(heliusEndpoint(secret), null);
    globalThis.fetch = async () => {throw Error('Must not contact upstream');};
    for (const config of [env({HELIUS_RPC_URL: undefined}), env({HELIUS_RPC_URL: undefined, HELIUS_RPC_UR: endpoint}), env({HELIUS_RPC_URL: 'HELIUS_RPC_URL'})]) assert.equal((await handleRequest(request(), config)).status, 503);
  });
  await test('accepts parameters needed by deployment, purchase, and expiry recovery', () => {
    for (const value of [
      call('getGenesisHash'), call('getLatestBlockhash', [{commitment: 'confirmed', minContextSlot: 100}]),
      call('getBalance', [treasury, {commitment: 'confirmed'}]), call('getMinimumBalanceForRentExemption', [105061, {commitment: 'confirmed'}]),
      call('getFeeForMessage', [b64, {commitment: 'confirmed'}]), call('getAccountInfo', [treasury, {encoding: 'base64', minContextSlot: 100}]),
      call('getAccountInfo', [treasury, {encoding: 'base64', dataSlice: {offset: 45, length: 105016}}]),
      call('getMultipleAccounts', [Array(62).fill(treasury), {encoding: 'base64', commitment: 'confirmed'}]),
      call('getRecentPrioritizationFees', [[treasury]]), call('getSignatureStatuses', [[sig], {searchTransactionHistory: true}]),
      call('getBlockHeight', [{commitment: 'finalized'}]), call('getEpochInfo', [{commitment: 'finalized'}]), call('getSlot'),
      call('getTransaction', [sig, {commitment: 'confirmed', maxSupportedTransactionVersion: 0}]),
      call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3, minContextSlot: 100}]),
      call('sendTransaction', [b64, {encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 3, minContextSlot: 100}]),
      call('simulateTransaction', [b64, {encoding: 'base64', sigVerify: false, replaceRecentBlockhash: false, commitment: 'confirmed', minContextSlot: 100}]),
    ]) assert(validRpcCall(value), value.method);
  });
  await test('blocks unrelated methods and excessive or malformed parameters', async () => {
    globalThis.fetch = async () => {throw Error('Must not contact upstream');};
    for (const value of [
      call('requestAirdrop', [treasury, 100]), call('getProgramAccounts', [treasury]), call('getAsset', [treasury]),
      call('getMinimumBalanceForRentExemption', [10_000_000]), call('getMultipleAccounts', [Array(101).fill(treasury)]),
      call('getSignatureStatuses', [Array(33).fill(sig)]), call('getRecentPrioritizationFees', [Array(33).fill(treasury)]),
      call('getBalance', [treasury, {commitment: 'invalid'}]), call('getAccountInfo', [treasury, {encoding: 'jsonParsed'}]),
      call('getAccountInfo', [treasury, {dataSlice: {offset: 0, length: 262145}}]),
      call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: true, maxRetries: 3}]),
      ...[null, 0, 1, 'false', {}, []].map(skipPreflight => call('sendTransaction', [b64, {encoding: 'base64', skipPreflight, maxRetries: 3}])),
      call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: false, maxRetries: 4}]),
      call('simulateTransaction', [b64, {encoding: 'base64', accounts: {addresses: Array(100).fill(treasury)}}]),
      call('getFeeForMessage', ['!'.repeat(1644)]), {...call('getGenesisHash'), id: null}, {...call('getGenesisHash'), jsonrpc: '1.0'},
    ]) assert.equal((await handleRequest(request(value), env())).status, 400, value.method);
  });
  await test('requires same-origin JSON POST and handles route and method boundaries', async () => {
    globalThis.fetch = async () => {throw Error('Must not contact upstream');};
    for (const headers of [{Origin: 'https://evil.example'}, {Origin: 'null'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await handleRequest(request(undefined, headers), env())).status, 403);
    const missing = request(); missing.headers.delete('Origin');
    assert.equal((await handleRequest(missing, env())).status, 403);
    assert.equal((await handleRequest(request(undefined, {'Content-Type': 'text/plain'}), env())).status, 415);
    assert.equal((await handleRequest(new Request(`${site}/api/rpc`), env())).status, 405);
    assert.equal((await handleRequest(new Request(`${site}/api/not-rpc`), env())).status, 404);
    assert.equal(await (await handleRequest(new Request(`${site}/owner/setup`), env())).text(), 'asset');
  });
  await test('bounds batches and charges every individual read against the rate limit', async () => {
    let calls = 0, tokens = 0;
    const limited = env({RPC_LIMIT: {limit: async () => {tokens++; return {success: true};}}});
    globalThis.fetch = async (_url, init) => {calls++; return new Response(JSON.stringify(JSON.parse(init.body).map(v => ({jsonrpc: '2.0', id: v.id, result: 1}))), {headers: {'Content-Type': 'application/json'}});};
    const good = [call('getSlot', [], 1), call('getBlockHeight', [], 2)];
    assert.equal((await handleRequest(request(good), limited)).status, 200);
    assert.equal(tokens, 2); assert.equal(calls, 1);
    for (const batch of [[], Array.from({length: 9}, (_, i) => call('getSlot', [], i)), [good[0], good[0]], [call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: false, maxRetries: 3}])], [call('simulateTransaction', [b64])]]) assert.equal((await handleRequest(request(batch), env())).status, 400);
    assert.equal(calls, 1);
  });
  await test('fails closed on absent rate binding, respects both read and send limits', async () => {
    globalThis.fetch = async () => {throw Error('Must not contact upstream');};
    assert.equal((await handleRequest(request(), env({RPC_LIMIT: undefined}))).status, 503);
    const denied = {limit: async () => ({success: false})};
    assert.equal((await handleRequest(request(), env({RPC_LIMIT: denied}))).status, 429);
    const send = call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: false, maxRetries: 3}]);
    assert.equal((await handleRequest(request(send), env({RPC_SEND_LIMIT: denied}))).status, 429);
  });
  await test('forwards a signed send once without cookies, headers, or redirect following', async () => {
    let sends = 0;
    globalThis.fetch = async (url, init) => {
      sends++; assert.equal(url, endpoint); assert.equal(init.redirect, 'manual');
      assert.deepEqual(Object.keys(init.headers).sort(), ['Accept', 'Content-Type']);
      assert.equal(JSON.parse(init.body).method, 'sendTransaction'); return reply(sig);
    };
    const send = call('sendTransaction', [b64, {encoding: 'base64', skipPreflight: false, maxRetries: 3}]);
    const result = await handleRequest(request(send, {Cookie: 'private=user', Authorization: 'do-not-forward'}), env());
    assert.equal(result.status, 200); assert.equal((await bodyOf(result)).result, sig); assert.equal(sends, 1);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  });
  await test('real browser SDK reproduces the old rejection and forwards signed v0 and legacy packets with preflight enabled', async () => {
    const fixedGate = '(p[1].skipPreflight === undefined || p[1].skipPreflight === false)';
    assert(source.includes(fixedGate), 'The counterfactual must restore the exact previous preflight validator');
    const previousSource = source.replace(fixedGate, 'p[1].skipPreflight === false');
    const previousWorker = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(previousSource)).toString('base64')}`);
    let activeHandler = previousWorker.handleRequest, upstreamCalls = 0;
    const outbound = [], forwarded = [];
    const browser = await browserRpcClient(async (url, init) => {
      assert.equal(url, `${site}/api/rpc`);
      const headers = new Headers(init.headers);
      headers.set('Origin', site); headers.set('Sec-Fetch-Site', 'same-origin');
      headers.set('CF-Connecting-IP', '192.0.2.1');
      outbound.push(JSON.parse(init.body));
      return activeHandler(new Request(url, {...init, headers}), env());
    });
    globalThis.fetch = async (url, init) => {
      upstreamCalls++; assert.equal(url, endpoint);
      const call = JSON.parse(init.body); forwarded.push(call);
      assert.equal(call.method, 'sendTransaction');
      assert.equal(call.params[1].skipPreflight, false);
      return reply(sig, call.id);
    };
    const payer = Keypair.generate(), destination = Keypair.generate().publicKey;
    const message = new TransactionMessage({payerKey: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: [SystemProgram.transfer({fromPubkey: payer.publicKey, toPubkey: destination, lamports: 1})]});
    const signedPacket = version => {
      const tx = new VersionedTransaction(version === 0 ? message.compileToV0Message() : message.compileToLegacyMessage());
      tx.sign([payer]); return Uint8Array.from(tx.serialize());
    };
    const deploymentOptions = {skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3, minContextSlot: 100};
    const connection = () => new browser.Connection(`${site}/api/rpc`, {commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: browser.createDeploymentRpcFetch()});
    const versioned = signedPacket(0);
    await assert.rejects(connection().sendRawTransaction(versioned, deploymentOptions), /400|Unsupported RPC/);
    assert.equal(upstreamCalls, 0, 'The old Worker discarded an actual SDK send before Helius');
    assert.equal(Object.hasOwn(outbound[0].params[1], 'skipPreflight'), false, 'web3.js omits false despite the explicit caller option');
    activeHandler = handleRequest;
    assert.equal(await connection().sendRawTransaction(versioned, deploymentOptions), sig);
    const legacy = signedPacket('legacy');
    const purchaseOptions = {skipPreflight: false, preflightCommitment: 'confirmed', minContextSlot: 101, maxRetries: 3};
    assert.equal(await connection().sendRawTransaction(legacy, purchaseOptions), sig);
    assert.equal(upstreamCalls, 2);
    for (const [index, packet] of [versioned, legacy].entries()) {
      assert.deepEqual(Buffer.from(forwarded[index].params[0], 'base64'), Buffer.from(packet), 'Signed packet must be forwarded byte for byte');
      assert.deepEqual(forwarded[index].params[1], {...outbound[index + 1].params[1], skipPreflight: false});
    }
  });
  await test('does not follow upstream redirects or leak authentication errors', async () => {
    for (const status of [301, 302, 307, 401, 403, 429, 500]) {
      let count = 0;
      globalThis.fetch = async () => {count++; return new Response(`${endpoint} PRIVATE`, {status, headers: {Location: 'https://evil.example/'}});};
      const result = await handleRequest(request(), env());
      assert.equal(count, 1); assert(result.status >= 400);
      const text = await result.text(); assert(!text.includes(fakeKey)); assert(!text.includes('PRIVATE'));
    }
  });
  await test('sanitizes JSON-RPC errors and rejects credentials echoed in results', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({jsonrpc: '2.0', id: 1, error: {code: -32002, message: endpoint, data: {logs: [fakeKey]}}}), {headers: {'Content-Type': 'application/json'}});
    const result = await bodyOf(await handleRequest(request(), env()));
    assert.equal(result.error.code, -32002); assert.equal(result.error.data, undefined); assert(!JSON.stringify(result).includes(fakeKey));
    globalThis.fetch = async () => reply({echo: endpoint});
    assert.equal((await handleRequest(request(), env())).status, 502);
  });
  await test('permits the full deployed program account needed for exact binary verification', async () => {
    const encodedProgram = Buffer.alloc(105016 + 45, 42).toString('base64');
    globalThis.fetch = async () => reply({context: {slot: 500}, value: {data: [encodedProgram, 'base64'], executable: false, owner: 'BPFLoaderUpgradeab1e11111111111111111111111', lamports: 500000000}});
    const response = await handleRequest(request(call('getAccountInfo', [treasury, {encoding: 'base64'}])), env());
    assert.equal(response.status, 200); assert.equal((await bodyOf(response)).result.value.data[0], encodedProgram);
  });
  await test('rejects oversized streamed request and response bodies', async () => {
    let contacted = 0;
    globalThis.fetch = async () => {contacted++; return reply('never');};
    const oversized = new Request(`${site}/api/rpc`, {method: 'POST', headers: {Origin: site, 'Content-Type': 'application/json'}, body: 'x'.repeat(RPC_MAX_REQUEST_BYTES + 1)});
    assert.equal((await handleRequest(oversized, env())).status, 413); assert.equal(contacted, 0);
    globalThis.fetch = async () => reply('x'.repeat(RPC_MAX_RESPONSE_BYTES));
    assert.equal((await handleRequest(request(), env())).status, 502);
  });
  await test('rejects malformed, wrong-ID, duplicate, and non-JSON upstream replies', async () => {
    for (const upstream of [reply(1, 'wrong-id'), new Response('{oops', {headers: {'Content-Type': 'application/json'}}), new Response('<html>', {headers: {'Content-Type': 'text/html'}}), new Response(JSON.stringify({jsonrpc: '2.0', id: 1}), {headers: {'Content-Type': 'application/json'}})]) {
      globalThis.fetch = async () => upstream;
      assert.equal((await handleRequest(request(), env())).status, 502);
    }
    globalThis.fetch = async () => new Response(JSON.stringify([{jsonrpc: '2.0', id: 1, result: 1}, {jsonrpc: '2.0', id: 1, result: 1}]), {headers: {'Content-Type': 'application/json'}});
    assert.equal((await handleRequest(request([call('getSlot', [], 1), call('getSlot', [], 2)]), env())).status, 502);
  });
  await test('health verifies mainnet through the upstream instead of only checking secret presence', async () => {
    const health = () => new Request(`${site}/api/rpc/health`, {headers: {'Sec-Fetch-Site': 'same-origin'}});
    globalThis.fetch = async (_url, init) => {assert.equal(JSON.parse(init.body).method, 'getGenesisHash'); return reply(genesis, 'health');};
    assert.deepEqual(await bodyOf(await handleRequest(health(), env())), {ok: true, network: 'mainnet-beta'});
    globalThis.fetch = async () => reply('devnet-genesis', 'health');
    assert.equal((await handleRequest(health(), env())).status, 502);
  });
  await test('bounds stalled fetch and response-body reads without submitting a second request', async () => {
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === worker.RPC_TIMEOUT_MS ? 10 : ms, ...args);
    try {
      let count = 0;
      globalThis.fetch = async (_url, init) => {count++; return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Error(endpoint)), {once: true}));};
      assert.equal((await handleRequest(request(), env())).status, 502); assert.equal(count, 1);
      globalThis.fetch = async () => new Response(new ReadableStream({start() {}}), {headers: {'Content-Type': 'application/json'}});
      assert.equal((await handleRequest(request(), env())).status, 502);
    } finally {globalThis.setTimeout = originalTimer;}
  });
} finally {globalThis.fetch = oldFetch;}
console.log(`RPC relay: ${passed} checks passed; no live network requests.`);
