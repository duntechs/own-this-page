// This relay never receives wallet keys. It forwards only reviewed JSON-RPC
// methods, and only signed transaction bytes can reach sendTransaction.
import {handleImages, type ImageEnv} from './images';

export interface Env extends ImageEnv {
  ASSETS: {fetch(request: Request): Promise<Response>};
  HELIUS_RPC_URL?: string;
  RPC_LIMIT?: {limit(input: {key: string}): Promise<{success: boolean}>};
  RPC_SEND_LIMIT?: {limit(input: {key: string}): Promise<{success: boolean}>};
}

type JsonObject = Record<string, unknown>;
type RpcCall = {jsonrpc: '2.0'; id: number | string; method: string; params?: unknown[]};
export const RPC_MAX_REQUEST_BYTES = 32 * 1024;
export const RPC_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const RPC_TIMEOUT_MS = 12_000;
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const base58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const object = (v: unknown): v is JsonObject => !!v && typeof v === 'object' && !Array.isArray(v);
const uint = (v: unknown, max = Number.MAX_SAFE_INTEGER) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
const key = (v: unknown) => typeof v === 'string' && v.length >= 32 && v.length <= 44 && base58.test(v);
const signature = (v: unknown) => typeof v === 'string' && v.length >= 64 && v.length <= 88 && base58.test(v);
const commitment = (v: unknown) => v === 'processed' || v === 'confirmed' || v === 'finalized';
const encoded = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 1644 && v.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v);
const keys = (v: unknown, max: number) => Array.isArray(v) && v.length > 0 && v.length <= max && v.every(key);
const allowedKeys = (v: JsonObject, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));

function options(value: unknown, extra: Record<string, (v: unknown) => boolean> = {}): boolean {
  if (value === undefined) return true;
  if (!object(value)) return false;
  const checks = {commitment, minContextSlot: (v: unknown) => uint(v), ...extra};
  return Object.entries(value).every(([name, v]) => Object.hasOwn(checks, name) && checks[name as keyof typeof checks](v));
}

const accountOptions = (v: unknown) => options(v, {
  encoding: value => value === 'base64',
  dataSlice: value => object(value) && allowedKeys(value, ['offset', 'length']) && uint(value.offset, 10 * 1024 * 1024) && uint(value.length, 262_144),
});

function validParams(method: string, p: unknown[]): boolean {
  switch (method) {
    case 'getGenesisHash': return p.length === 0;
    case 'getLatestBlockhash':
    case 'getBlockHeight':
    case 'getSlot':
    case 'getEpochInfo': return p.length <= 1 && options(p[0]);
    case 'getBalance': return p.length >= 1 && p.length <= 2 && key(p[0]) && options(p[1]);
    case 'getAccountInfo': return p.length >= 1 && p.length <= 2 && key(p[0]) && accountOptions(p[1]);
    case 'getMultipleAccounts': return p.length >= 1 && p.length <= 2 && keys(p[0], 100) && accountOptions(p[1]);
    case 'getMinimumBalanceForRentExemption': return p.length >= 1 && p.length <= 2 && uint(p[0], 262_144) && options(p[1]);
    case 'getFeeForMessage': return p.length >= 1 && p.length <= 2 && encoded(p[0]) && options(p[1]);
    case 'getRecentPrioritizationFees': return p.length === 0 || p.length === 1 && (Array.isArray(p[0]) && p[0].length === 0 || keys(p[0], 32));
    case 'getSignatureStatuses': return p.length >= 1 && p.length <= 2 && Array.isArray(p[0]) && p[0].length >= 1 && p[0].length <= 32 && p[0].every(signature) && (p[1] === undefined || object(p[1]) && allowedKeys(p[1], ['searchTransactionHistory']) && typeof p[1].searchTransactionHistory === 'boolean');
    case 'getTransaction': return p.length >= 1 && p.length <= 2 && signature(p[0]) && options(p[1], {encoding: v => v === 'json' || v === 'jsonParsed' || v === 'base64', maxSupportedTransactionVersion: v => v === 0});
    // web3.js omits skipPreflight when its value is false. Omission has the
    // same RPC meaning; true and malformed values must still be rejected.
    case 'sendTransaction': return p.length === 2 && encoded(p[0]) && object(p[1]) && p[1].encoding === 'base64' && (p[1].skipPreflight === undefined || p[1].skipPreflight === false) && allowedKeys(p[1], ['encoding', 'skipPreflight', 'preflightCommitment', 'maxRetries', 'minContextSlot']) && (p[1].preflightCommitment === undefined || commitment(p[1].preflightCommitment)) && uint(p[1].maxRetries, 3) && (p[1].minContextSlot === undefined || uint(p[1].minContextSlot));
    case 'simulateTransaction': return p.length >= 1 && p.length <= 2 && encoded(p[0]) && options(p[1], {encoding: v => v === 'base64', sigVerify: v => typeof v === 'boolean', replaceRecentBlockhash: v => typeof v === 'boolean'});
    default: return false;
  }
}

export function validRpcCall(value: unknown): value is RpcCall {
  if (!object(value) || !allowedKeys(value, ['jsonrpc', 'id', 'method', 'params']) || value.jsonrpc !== '2.0') return false;
  if (!(typeof value.id === 'string' && value.id.length <= 80 || typeof value.id === 'number' && Number.isSafeInteger(value.id))) return false;
  return typeof value.method === 'string' && (value.params === undefined || Array.isArray(value.params)) && validParams(value.method, (value.params ?? []) as unknown[]);
}

export function heliusEndpoint(secret: unknown): URL | null {
  if (typeof secret !== 'string' || secret.length > 1024 || secret !== secret.trim()) return null;
  try {
    const endpoint = new URL(secret);
    const apiKey = endpoint.searchParams.get('api-key');
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'mainnet.helius-rpc.com' || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname !== '/') return null;
    if ([...endpoint.searchParams.keys()].length !== 1 || !apiKey || !/^[A-Za-z0-9_-]{16,256}$/.test(apiKey)) return null;
    return endpoint;
  } catch {return null;}
}

function json(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra,
  }});
}

function error(code: number, message: string, status: number, id: RpcCall['id'] | null = null): Response {
  return json({jsonrpc: '2.0', id, error: {code, message}}, status, status === 429 ? {'Retry-After': '10'} : {});
}

class BodyLimitError extends Error {}
async function limitedText(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<string> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let abort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    abort = () => {void reader.cancel().catch(() => {}); reject(new Error('Timeout'));};
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, {once: true});
  });
  try {
    for (;;) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) {void reader.cancel().catch(() => {}); throw new BodyLimitError();}
      chunks.push(part.value);
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {joined.set(chunk, offset); offset += chunk.byteLength;}
    return new TextDecoder('utf-8', {fatal: true}).decode(joined);
  } finally {signal.removeEventListener('abort', abort); reader.releaseLock();}
}

function sanitizedRpcResponse(value: unknown, calls: RpcCall[], isBatch: boolean): unknown {
  const values = isBatch ? value : [value];
  if (!Array.isArray(values) || values.length !== calls.length) throw Error('Invalid RPC reply');
  const seen = new Set<string>();
  const replies = values.map(item => {
    if (!object(item) || item.jsonrpc !== '2.0' || !calls.some(call => call.id === item.id)) throw Error('Invalid RPC reply');
    const id = JSON.stringify(item.id);
    if (seen.has(id)) throw Error('Duplicate RPC reply');
    seen.add(id);
    if (object(item.error) && typeof item.error.code === 'number' && Number.isInteger(item.error.code)) {
      // Upstream messages/data can echo a credential-bearing URL. Preserve only
      // the error code; callers still reconcile saved signatures before retrying.
      const message = item.error.code === -32002 ? 'Solana rejected transaction preflight. No transaction was accepted by this request.'
        : 'The Solana provider could not complete this request. Check saved transaction status before retrying.';
      return {jsonrpc: '2.0', id: item.id, error: {code: item.error.code, message}};
    }
    if (!Object.hasOwn(item, 'result') || Object.hasOwn(item, 'error')) throw Error('Invalid RPC reply');
    return {jsonrpc: '2.0', id: item.id, result: item.result};
  });
  return isBatch ? replies : replies[0];
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === '/api/images' || url.pathname.startsWith('/api/images/') || url.pathname.startsWith('/media/')) return handleImages(request, env);
  if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
  const health = url.pathname === '/api/rpc/health';
  if (url.pathname !== '/api/rpc' && !health) return error(-32601, 'Unknown API route.', 404);
  if (url.search) return error(-32600, 'RPC query parameters are not accepted.', 400);
  if (health ? request.method !== 'GET' : request.method !== 'POST') return error(-32600, health ? 'Use GET for the connection check.' : 'Use POST for RPC requests.', 405);
  const origin = request.headers.get('Origin');
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (origin !== null && origin !== url.origin || !health && origin !== url.origin || fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') return error(-32600, 'RPC requests must come from this website.', 403);
  if (!health && request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return error(-32600, 'Use application/json.', 415);
  const endpoint = heliusEndpoint(env.HELIUS_RPC_URL);
  if (!endpoint) return error(-32002, 'Add a valid Helius mainnet endpoint as the Cloudflare Worker runtime secret HELIUS_RPC_URL.', 503);
  // Bindings are declared in wrangler.jsonc. A missing binding must not silently
  // turn the paid upstream into an unlimited public proxy.
  if (!env.RPC_LIMIT || !env.RPC_SEND_LIMIT) return error(-32002, 'The website RPC rate-limit bindings need to be deployed.', 503);
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const rateKey = `own-this-page:${ip}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let id: RpcCall['id'] | null = null;
  try {
    if (!(await env.RPC_LIMIT.limit({key: rateKey})).success) return error(-32005, 'Too many requests. Wait a few seconds and retry.', 429);
    let parsed: unknown;
    if (health) parsed = {jsonrpc: '2.0', id: 'health', method: 'getGenesisHash'};
    else {
      const statedLength = request.headers.get('Content-Length');
      if (statedLength !== null && (!/^\d+$/.test(statedLength) || Number(statedLength) > RPC_MAX_REQUEST_BYTES)) return error(-32600, 'RPC request is too large.', 413);
      try {parsed = JSON.parse(await limitedText(request.body, RPC_MAX_REQUEST_BYTES, controller.signal));}
      catch (failure) {return error(-32600, failure instanceof BodyLimitError ? 'RPC request is too large.' : 'Invalid or incomplete JSON request.', failure instanceof BodyLimitError ? 413 : 400);}
    }
    const batch = Array.isArray(parsed);
    const calls: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    if (!calls.length || calls.length > 8 || !calls.every(validRpcCall)) return error(-32600, 'Unsupported RPC method or parameters.', 400);
    if (!batch) id = calls[0].id;
    if (new Set(calls.map(call => JSON.stringify(call.id))).size !== calls.length) return error(-32600, 'RPC request IDs must be unique.', 400);
    if (batch && calls.some(call => call.method === 'sendTransaction' || call.method === 'simulateTransaction')) return error(-32600, 'Send and simulation requests must be submitted individually.', 400);
    for (let index = 1; index < calls.length; index++) {
      if (!(await env.RPC_LIMIT.limit({key: rateKey})).success) return error(-32005, 'Too many requests. Wait a few seconds and retry.', 429);
    }
    if (calls.some(call => call.method === 'sendTransaction') && !(await env.RPC_SEND_LIMIT.limit({key: rateKey})).success) return error(-32005, 'Too many transaction submissions. Check the previous transaction before retrying.', 429);
    // Keep preflight explicit upstream even when the SDK omitted false. Only
    // the send options are normalized; approved transaction bytes are intact.
    const forwardedCalls = calls.map(call => call.method === 'sendTransaction'
      ? {...call, params: [call.params![0], {...call.params![1] as JsonObject, skipPreflight: false}]}
      : call);
    const response = await fetch(endpoint.href, {
      method: 'POST', headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify(batch ? forwardedCalls : forwardedCalls[0]), signal: controller.signal, redirect: 'manual',
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return error(-32002, 'Helius rejected the RPC credential. Check the Worker runtime secret and Helius key restrictions.', 503, id);
      return error(-32005, response.status === 429 ? 'Helius is rate limiting requests. Wait before checking again.' : 'The Solana provider did not return a usable response. Check saved transaction status before retrying.', response.status === 429 ? 429 : 502, id);
    }
    if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {void response.body?.cancel().catch(() => {}); throw Error('Invalid RPC content type');}
    const replyText = await limitedText(response.body, RPC_MAX_RESPONSE_BYTES, controller.signal);
    const reply = sanitizedRpcResponse(JSON.parse(replyText), calls, batch);
    // Also reject credentials echoed inside otherwise successful result values.
    // Do not log requests, URLs, response bodies, or caught upstream errors.
    const safeText = JSON.stringify(reply);
    if (safeText.includes(endpoint.searchParams.get('api-key')!) || safeText.includes('mainnet.helius-rpc.com/?api-key=')) throw Error('Unsafe RPC response');
    if (health) {
      if (!object(reply) || reply.result !== MAINNET_GENESIS) return error(-32002, 'The Solana mainnet connection could not be verified.', 502);
      return json({ok: true, network: 'mainnet-beta'});
    }
    return json(reply);
  } catch {
    return error(-32005, 'RPC response unavailable. Check saved transaction status before retrying.', 502, id);
  } finally {clearTimeout(timer); controller.abort();}
}

export default {fetch: handleRequest};
