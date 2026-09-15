// Uploads are public raster images. A short-lived wallet signature authorizes
// precisely these bytes for this origin; no wallet or R2 secret reaches a client.
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const IMAGE_TIMEOUT_MS = 20_000;
type ImageObject = {size: number; customMetadata?: Record<string, string>; httpMetadata?: {contentType?: string}};
type ImageObjectBody = ImageObject & {body: ReadableStream<Uint8Array>};
export interface ImageEnv {
  IMAGES?: {
    head(key: string): Promise<ImageObject | null>;
    get(key: string): Promise<ImageObjectBody | null>;
    put(key: string, value: Uint8Array, options: {
      onlyIf: {etagDoesNotMatch: string};
      httpMetadata: {contentType: string; cacheControl: string};
      customMetadata: Record<string, string>;
      sha256: string;
    }): Promise<ImageObject | null>;
  };
  IMAGE_UPLOAD_LIMIT?: {limit(input: {key: string}): Promise<{success: boolean}>};
}
type ImageKind = {mime: 'image/jpeg' | 'image/png' | 'image/webp'; extension: 'jpg' | 'png' | 'webp'};
const cacheControl = 'public, max-age=31536000, immutable';
const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
const ascii = (bytes: Uint8Array, offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));

export function imageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return {mime: 'image/jpeg', extension: 'jpg'};
  if (bytes.length >= 45 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) && ascii(bytes, 12, 4) === 'IHDR' && ascii(bytes, bytes.length - 8, 4) === 'IEND') {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (view.getUint32(8) === 13 && width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 32_000_000) return {mime: 'image/png', extension: 'png'};
  }
  if (bytes.length >= 20 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(bytes, 12, 4)) && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, true) === bytes.length - 8) return {mime: 'image/webp', extension: 'webp'};
  return null;
}

function walletKey(value: string): Uint8Array | null {
  if (value.length < 32 || value.length > 44) return null;
  let number = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {bytes.unshift(Number(number & 255n)); number >>= 8n;}
  for (const char of value) {if (char !== '1') break; bytes.unshift(0);}
  return bytes.length === 32 ? new Uint8Array(bytes) : null;
}

function signatureBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(value)) return null;
  try {
    const decoded = atob(value);
    return decoded.length === 64 && btoa(decoded) === value ? Uint8Array.from(decoded, char => char.charCodeAt(0)) : null;
  } catch {return null;}
}

export function imageUploadMessage(origin: string, wallet: string, sha256: string, timestamp: string): string {
  return `Own This Page image upload\nOrigin: ${origin}\nWallet: ${wallet}\nSHA-256: ${sha256}\nTime: ${timestamp}`;
}

function response(value: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra}});
}
const failure = (message: string, status: number) => response({error: message}, status, status === 429 ? {'Retry-After': '60'} : {});
class UploadLimitError extends Error {}
class UploadTimeoutError extends Error {}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      abort = () => reject(new UploadTimeoutError());
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, {once: true});
    })]);
  } finally {signal.removeEventListener('abort', abort);}
}

async function imageBytes(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new UploadLimitError();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await bounded(reader.read(), signal);
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_IMAGE_BYTES) throw new UploadLimitError();
      chunks.push(part.value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {output.set(chunk, offset); offset += chunk.length;}
    return output;
  } catch (error) {void reader.cancel().catch(() => {}); throw error;}
  finally {reader.releaseLock();}
}

async function serveImage(request: Request, env: ImageEnv, url: URL, signal: AbortSignal): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure('Use GET to view an image.', 405);
  const match = /^\/media\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(url.pathname);
  if (!match || url.search) return failure('Image not found.', 404);
  if (!env.IMAGES) return failure('Image storage is not configured yet.', 503);
  const [, hash, extension] = match;
  const stored = await bounded(env.IMAGES.get(`images/${hash}.${extension}`), signal);
  if (!stored) return failure('Image not found.', 404);
  const mime = extension === 'jpg' ? 'image/jpeg' : `image/${extension}`;
  if (!Number.isSafeInteger(stored.size) || stored.size <= 0 || stored.size > MAX_IMAGE_BYTES || stored.customMetadata?.sha256 !== hash || stored.httpMetadata?.contentType !== mime) {
    void stored.body.cancel().catch(() => {});
    return failure('Image not found.', 404);
  }
  const etag = `"${hash}"`;
  const headers = {
    'Content-Type': mime, 'Content-Length': String(stored.size), 'ETag': etag,
    'Cache-Control': cacheControl, 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `inline; filename="${hash}.${extension}"`,
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Referrer-Policy': 'no-referrer',
  };
  if (request.headers.get('If-None-Match')?.split(',').map(s => s.trim()).includes(etag)) {
    void stored.body.cancel().catch(() => {});
    return new Response(null, {status: 304, headers});
  }
  if (request.method === 'HEAD') {void stored.body.cancel().catch(() => {}); return new Response(null, {headers});}
  const bytes = await imageBytes(stored.body, signal);
  if (bytes.length !== stored.size) return failure('The stored image is incomplete.', 502);
  return new Response(Uint8Array.from(bytes), {headers});
}

export async function handleImages(request: Request, env: ImageEnv): Promise<Response> {
  const url = new URL(request.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
  try {
    if (url.pathname.startsWith('/media/')) return await serveImage(request, env, url, controller.signal);
    if (url.pathname === '/api/images/health' && request.method === 'GET' && !url.search) return response({configured: !!env.IMAGES && !!env.IMAGE_UPLOAD_LIMIT});
    if (url.pathname !== '/api/images' || url.search) return failure('Unknown image route.', 404);
    if (request.method !== 'POST') return failure('Use POST to upload an image.', 405);
    if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') && request.headers.get('Sec-Fetch-Site') !== 'same-origin') return failure('Upload from this website.', 403);
    if (!env.IMAGES || !env.IMAGE_UPLOAD_LIMIT) return failure('Image uploads are not configured yet. The owner must connect image storage.', 503);
    const mime = request.headers.get('Content-Type')?.toLowerCase().trim();
    if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return failure('Choose a JPEG, PNG, or WebP image.', 415);
    const wallet = request.headers.get('X-Upload-Wallet') ?? '';
    const timestamp = request.headers.get('X-Upload-Time') ?? '';
    const publicKey = walletKey(wallet), signature = signatureBytes(request.headers.get('X-Upload-Signature') ?? '');
    const now = Math.floor(Date.now() / 1000), seconds = Number(timestamp);
    if (!publicKey || !signature || !/^[1-9][0-9]{9,12}$/.test(timestamp) || !Number.isSafeInteger(seconds) || seconds < now - 300 || seconds > now + 30) return failure('Connect your wallet and approve a fresh image upload message.', 401);
    const statedLength = request.headers.get('Content-Length');
    if (statedLength !== null && (!/^[0-9]+$/.test(statedLength) || Number(statedLength) <= 0 || Number(statedLength) > MAX_IMAGE_BYTES)) return failure('Images must be no larger than 3 MB.', 413);
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (!(await bounded(env.IMAGE_UPLOAD_LIMIT.limit({key: `own-page:image:ip:${ip}`}), controller.signal)).success) return failure('Too many image uploads. Wait a minute before trying again.', 429);
    const bytes = await imageBytes(request.body, controller.signal);
    if (!bytes.length) return failure('Choose an image file.', 400);
    const kind = imageKind(bytes);
    if (!kind || kind.mime !== mime) return failure('The file contents must match its JPEG, PNG, or WebP image type.', 415);
    const sha256 = hex(await bounded(crypto.subtle.digest('SHA-256', Uint8Array.from(bytes)), controller.signal));
    const imported = await bounded(crypto.subtle.importKey('raw', Uint8Array.from(publicKey), {name: 'Ed25519'}, false, ['verify']), controller.signal);
    const valid = await bounded(crypto.subtle.verify('Ed25519', imported, Uint8Array.from(signature), new TextEncoder().encode(imageUploadMessage(url.origin, wallet, sha256, timestamp))), controller.signal);
    if (!valid) return failure('The wallet signature does not match this image upload.', 401);
    if (!(await bounded(env.IMAGE_UPLOAD_LIMIT.limit({key: `own-page:image:wallet:${wallet}`}), controller.signal)).success) return failure('Too many uploads from this wallet. Wait a minute before trying again.', 429);
    const key = `images/${sha256}.${kind.extension}`;
    const existing = await bounded(env.IMAGES.head(key), controller.signal);
    if (existing) {
      if (existing.size !== bytes.length || existing.customMetadata?.sha256 !== sha256 || existing.httpMetadata?.contentType !== mime) return failure('The stored image could not be verified.', 502);
    } else {
      const stored = await bounded(env.IMAGES.put(key, bytes, {
        onlyIf: {etagDoesNotMatch: '*'}, sha256,
        httpMetadata: {contentType: kind.mime, cacheControl}, customMetadata: {sha256, wallet},
      }), controller.signal);
      // A concurrent identical upload can win the conditional put. Confirm it
      // exists before returning success; the same image never replaces bytes.
      if (!stored) {
        const concurrent = await bounded(env.IMAGES.head(key), controller.signal);
        if (!concurrent || concurrent.size !== bytes.length || concurrent.customMetadata?.sha256 !== sha256 || concurrent.httpMetadata?.contentType !== mime) return failure('The image upload could not be confirmed. Retry the same image.', 502);
      }
    }
    return response({url: `${url.origin}/media/${sha256}.${kind.extension}`, sha256, bytes: bytes.length, contentType: kind.mime}, existing ? 200 : 201);
  } catch (error) {
    if (error instanceof UploadLimitError) return failure('Images must be no larger than 3 MB.', 413);
    if (error instanceof UploadTimeoutError) return failure('Image storage took too long. Retry the same image; it will not create a duplicate.', 504);
    return failure('Image storage is temporarily unavailable. Retry the same image.', 502);
  } finally {clearTimeout(timer); controller.abort();}
}
