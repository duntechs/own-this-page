import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

const source = await readFile(new URL('../worker/images.ts', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`;
const {handleImages, imageUploadMessage, MAX_IMAGE_BYTES, IMAGE_TIMEOUT_MS} = await import(moduleUrl);
const diagnosticSource = await readFile(new URL('../lib/solana-deployment-fetch.ts', import.meta.url), 'utf8');
const diagnosticModule = `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(diagnosticSource)).toString('base64')}`;
const indexSource = (await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8')).replace("from './images'", `from '${moduleUrl}'`).replace("from '../lib/solana-deployment-fetch'", `from '${diagnosticModule}'`);
const {handleRequest} = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(indexSource)).toString('base64')}`);
const originalFetch = globalThis.fetch, originalNow = Date.now;
const timestamp = Math.floor(originalNow() / 1000);
Date.now = () => timestamp * 1000;
globalThis.fetch = async () => {throw Error('Image worker tests must never call a live network.');};
const origin = 'https://ownthispage.page';
const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZGXQAAAAASUVORK5CYII=', 'base64'));
const sha = async bytes => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), result = '';
  while (value) {result = alphabet[Number(value % 58n)] + result; value /= 58n;}
  for (const byte of bytes) {if (byte !== 0) break; result = '1' + result;}
  return result;
}
const signer = await crypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
const secondSigner = await crypto.subtle.generateKey({name: 'Ed25519'}, true, ['sign', 'verify']);
const wallet = base58(new Uint8Array(await crypto.subtle.exportKey('raw', signer.publicKey)));
const secondWallet = base58(new Uint8Array(await crypto.subtle.exportKey('raw', secondSigner.publicKey)));

function bucket() {
  const objects = new Map();
  let writes = 0, puts = 0;
  return {
    objects, get writes() {return writes;}, get puts() {return puts;},
    async head(key) {const found = objects.get(key); return found ? {...found, body: undefined} : null;},
    async get(key) {const found = objects.get(key); return found ? {...found, body: new Response(found.bytes).body} : null;},
    async put(key, bytes, options) {
      puts++; assert.equal(options.onlyIf.etagDoesNotMatch, '*');
      assert.equal(options.sha256, await sha(bytes));
      if (objects.has(key)) return null;
      writes++;
      const found = {size: bytes.length, bytes: Uint8Array.from(bytes), customMetadata: {...options.customMetadata}, httpMetadata: {...options.httpMetadata}};
      objects.set(key, found); return found;
    },
  };
}
const environment = (extra = {}) => ({IMAGES: bucket(), IMAGE_UPLOAD_LIMIT: {limit: async () => ({success: true})}, ...extra});
async function request(bytes = png, options = {}) {
  const time = String(options.time ?? timestamp);
  const signedWallet = options.signedWallet ?? wallet;
  const signedOrigin = options.signedOrigin ?? origin;
  const signedBytes = options.signedBytes ?? bytes;
  const text = imageUploadMessage(signedOrigin, signedWallet, await sha(signedBytes), time);
  const signature = Buffer.from(await crypto.subtle.sign('Ed25519', (options.signer ?? signer).privateKey, new TextEncoder().encode(text))).toString('base64');
  return new Request(`${origin}/api/images`, {method: 'POST', headers: {
    Origin: origin, 'Content-Type': options.mime ?? 'image/png', 'CF-Connecting-IP': '192.0.2.1',
    'X-Upload-Wallet': signedWallet, 'X-Upload-Time': time, 'X-Upload-Signature': signature,
    ...options.headers,
  }, body: bytes});
}
let passed = 0;
async function test(name, fn) {await fn(); passed++; console.log(`ok ${passed} - ${name}`);}
try {
  await test('optional image storage reports ready only when bucket and limit are connected', async () => {
    const health = () => new Request(`${origin}/api/images/health`);
    assert.deepEqual(await (await handleImages(health(), {})).json(), {configured: false});
    assert.deepEqual(await (await handleImages(health(), environment({IMAGE_UPLOAD_LIMIT: undefined}))).json(), {configured: false});
    assert.deepEqual(await (await handleImages(health(), environment())).json(), {configured: true});
    assert.equal((await handleImages(await request(), {})).status, 503);
  });
  await test('signed PNG upload stores exact bytes privately and returns a public content-addressed URL', async () => {
    const env = environment(), req = await request();
    const result = await handleImages(req, env);
    assert.equal(result.status, 201);
    const value = await result.json(), hash = await sha(png);
    assert.equal(value.url, `${origin}/media/${hash}.png`);
    assert.equal(value.sha256, hash); assert.equal(value.bytes, png.length); assert.equal(value.contentType, 'image/png');
    assert.equal(env.IMAGES.writes, 1);
    assert.deepEqual(env.IMAGES.objects.get(`images/${hash}.png`).bytes, png);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
  });
  await test('replaying the same signed image is idempotent and never overwrites an object', async () => {
    const env = environment(), first = await request();
    const second = first.clone();
    const a = await handleImages(first, env), b = await handleImages(second, env);
    assert.equal(a.status, 201); assert.equal(b.status, 200);
    assert.equal((await a.json()).url, (await b.json()).url);
    assert.equal(env.IMAGES.writes, 1); assert.equal(env.IMAGES.puts, 1);
  });
  await test('concurrent identical uploads converge on a single immutable image', async () => {
    const env = environment(), req = await request();
    const results = await Promise.all([handleImages(req.clone(), env), handleImages(req.clone(), env)]);
    assert(results.every(r => r.status === 200 || r.status === 201));
    assert.equal(env.IMAGES.writes, 1);
    assert.equal((await results[0].json()).url, (await results[1].json()).url);
  });
  await test('rejects missing signatures, different wallets, and altered image or origin proofs', async () => {
    const env = environment();
    for (const req of [
      await request(png, {headers: {'X-Upload-Signature': ''}}),
      await request(png, {headers: {'X-Upload-Wallet': secondWallet}}),
      await request(png, {signer: secondSigner}),
      await request(png, {signedOrigin: 'https://other.example'}),
      await request(png, {signedBytes: new Uint8Array([1, 2, 3])}),
      await request(png, {headers: {'X-Upload-Wallet': '1'.repeat(44)}}),
      await request(png, {headers: {'X-Upload-Signature': Buffer.alloc(64).toString('base64')}}),
    ]) assert.equal((await handleImages(req, env)).status, 401);
    assert.equal(env.IMAGES.writes, 0);
  });
  await test('signature expiry allows only five minutes past and thirty seconds future', async () => {
    for (const time of [timestamp - 301, timestamp + 31]) assert.equal((await handleImages(await request(png, {time}), environment())).status, 401);
    for (const time of [timestamp - 300, timestamp + 30]) assert.equal((await handleImages(await request(png, {time}), environment())).status, 201);
    assert.equal((await handleImages(await request(png, {headers: {'X-Upload-Time': `0${timestamp}`}}), environment())).status, 401);
  });
  await test('same-origin upload boundary blocks cross-site requests before storage', async () => {
    const env = environment();
    for (const headers of [{Origin: 'https://evil.example'}, {Origin: 'null'}, {'Sec-Fetch-Site': 'cross-site'}]) assert.equal((await handleImages(await request(png, {headers}), env)).status, 403);
    const req = await request(); req.headers.delete('Origin');
    assert.equal((await handleImages(req, env)).status, 403);
    assert.equal(env.IMAGES.writes, 0);
  });
  await test('limits both the IP and the verified signing wallet independently', async () => {
    const seen = [];
    let deny = 'ip';
    const env = environment({IMAGE_UPLOAD_LIMIT: {limit: async ({key}) => {seen.push(key); return {success: !key.includes(`:${deny}:`)};}}});
    assert.equal((await handleImages(await request(), env)).status, 429);
    assert.equal(seen.length, 1);
    deny = 'wallet';
    assert.equal((await handleImages(await request(), env)).status, 429);
    assert(seen.includes(`own-page:image:wallet:${wallet}`));
    assert.equal(env.IMAGES.writes, 0);
  });
  await test('rejects oversized or empty bodies, including lying Content-Length headers', async () => {
    const env = environment();
    assert.equal((await handleImages(await request(new Uint8Array(MAX_IMAGE_BYTES + 1)), env)).status, 413);
    assert.equal((await handleImages(await request(new Uint8Array(MAX_IMAGE_BYTES + 1), {headers: {'Content-Length': '10'}}), env)).status, 413);
    assert.equal((await handleImages(await request(png, {headers: {'Content-Length': String(MAX_IMAGE_BYTES + 1)}}), env)).status, 413);
    assert.equal((await handleImages(await request(new Uint8Array()), env)).status, 400);
    assert.equal(env.IMAGES.writes, 0);
  });
  await test('validates raster signatures and MIME while refusing SVG, HTML, and MIME spoofing', async () => {
    const env = environment();
    for (const [bytes, mime] of [[png, 'image/jpeg'], [png, 'image/svg+xml'], [new TextEncoder().encode('<svg/>'), 'image/png'], [new TextEncoder().encode('<html><script>alert(1)</script></html>'), 'image/jpeg'], [new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg']]) assert.equal((await handleImages(await request(bytes, {mime}), env)).status, 415);
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 74, 70, 73, 70, 255, 217]);
    const webp = new Uint8Array(24); webp.set(new TextEncoder().encode('RIFF')); new DataView(webp.buffer).setUint32(4, 16, true); webp.set(new TextEncoder().encode('WEBPVP8 '), 8);
    assert.equal((await handleImages(await request(jpeg, {mime: 'image/jpeg'}), env)).status, 201);
    assert.equal((await handleImages(await request(webp, {mime: 'image/webp'}), env)).status, 201);
  });
  await test('public media serves only fixed image MIME with immutable cache headers and conditional GET', async () => {
    const env = environment();
    const url = (await (await handleImages(await request(), env)).json()).url;
    const result = await handleImages(new Request(url), env);
    assert.equal(result.status, 200); assert.equal(result.headers.get('Content-Type'), 'image/png');
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff'); assert.match(result.headers.get('Cache-Control'), /immutable/);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), png);
    const etag = result.headers.get('ETag'); assert.equal(etag, `"${await sha(png)}"`);
    assert.equal((await handleImages(new Request(url, {headers: {'If-None-Match': etag}}), env)).status, 304);
    const head = await handleImages(new Request(url, {method: 'HEAD'}), env); assert.equal(head.status, 200); assert.equal((await head.text()).length, 0);
    for (const suffix of ['/media/arbitrary.svg', `/media/${'a'.repeat(64)}.html`, `/media/${'a'.repeat(64)}.png`, '/media/../../secrets']) assert.equal((await handleImages(new Request(origin + suffix), env)).status, 404);
    assert.equal((await handleImages(new Request(url, {method: 'DELETE'}), env)).status, 405);
  });
  await test('does not return successful URLs for failed or unconfirmed object writes', async () => {
    const rejecting = bucket(); rejecting.put = async () => {throw Error('PRIVATE R2 CREDENTIAL');};
    const result = await handleImages(await request(), environment({IMAGES: rejecting}));
    assert.equal(result.status, 502); assert(!await result.text().then(text => text.includes('PRIVATE')));
    const ambiguous = bucket(); ambiguous.put = async () => null;
    assert.equal((await handleImages(await request(), environment({IMAGES: ambiguous}))).status, 502);
  });
  await test('times out stalled upload streams and R2 operations', async () => {
    const originalTimer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => originalTimer(fn, ms === IMAGE_TIMEOUT_MS ? 10 : ms, ...args);
    try {
      const stalled = bucket(); stalled.head = async () => new Promise(() => {});
      assert.equal((await handleImages(await request(), environment({IMAGES: stalled}))).status, 504);
      const valid = await request();
      const stream = new Request(valid.url, {method: 'POST', headers: valid.headers, body: new ReadableStream({start() {}}), duplex: 'half'});
      assert.equal((await handleImages(stream, environment())).status, 504);
    } finally {globalThis.setTimeout = originalTimer;}
  });
  await test('root Worker routes uploads and media without a Helius credential', async () => {
    const env = {...environment(), ASSETS: {fetch: async () => new Response('frontend')}};
    const result = await handleRequest(await request(), env);
    assert.equal(result.status, 201);
    assert.equal((await handleRequest(new Request((await result.json()).url), env)).status, 200);
    assert.equal((await handleRequest(new Request(`${origin}/api/images/health`), env)).status, 200);
  });
  await test('image-enabled Wrangler config matches the default except for optional R2 provisioning', async () => {
    const parse = async name => JSON.parse((await readFile(new URL(`../${name}`, import.meta.url), 'utf8')).replace(/^\s*\/\/.*$/gm, ''));
    const basic = await parse('wrangler.jsonc'), images = await parse('wrangler.images.jsonc');
    assert.deepEqual(images.r2_buckets, [{binding: 'IMAGES'}]);
    delete images.r2_buckets; assert.deepEqual(images, basic);
    assert(basic.assets.run_worker_first.includes('/media/*'));
    assert.deepEqual(basic.ratelimits.find(v => v.name === 'IMAGE_UPLOAD_LIMIT').simple, {limit: 5, period: 60});
  });
} finally {globalThis.fetch = originalFetch; Date.now = originalNow;}
console.log(`Image uploads: ${passed} checks passed; no live requests or uploads.`);
