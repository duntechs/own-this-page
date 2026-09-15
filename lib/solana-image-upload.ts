import {Buffer} from 'buffer';
import {signSolanaImageUpload, type SolanaWalletSession} from './solana-wallet';

export const MAX_PLACEMENT_IMAGE_BYTES = 3 * 1024 * 1024;
export function placementImageType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (bytes.length < 12 || bytes.length > MAX_PLACEMENT_IMAGE_BYTES) throw Error('Choose an image up to 3 MB.');
  if (Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (Buffer.from(bytes.subarray(0,4)).toString() === 'RIFF' && Buffer.from(bytes.subarray(8,12)).toString() === 'WEBP') return 'image/webp';
  throw Error('Choose a PNG, JPG, or WebP image.');
}
export async function uploadPlacementImage(file: File, session: SolanaWalletSession): Promise<string> {
  if (!file.size || file.size > MAX_PLACEMENT_IMAGE_BYTES) throw Error('Choose an image up to 3 MB.');
  if (location.protocol !== 'https:') throw Error('Open the live HTTPS website to upload an image.');
  const origin = location.origin;
  const actor = session.account.address;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = placementImageType(bytes);
  const digest = Buffer.from(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = new TextEncoder().encode(`Own This Page image upload\nOrigin: ${origin}\nWallet: ${actor}\nSHA-256: ${digest}\nTime: ${timestamp}`);
  const signature = await signSolanaImageUpload(session, message);
  const response = await fetch('/api/images', {method: 'POST', headers: {'Content-Type': type,
    'X-Upload-Wallet': actor, 'X-Upload-Time': timestamp, 'X-Upload-Signature': Buffer.from(signature).toString('base64')},
    body: bytes, signal: AbortSignal.timeout(30_000)});
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw Error('Image storage is not configured on this website yet.');
  const result = await response.json();
  if (!response.ok) throw Error(typeof result.error === 'string' ? result.error : 'The image could not be uploaded. Try again in a moment.');
  const extension = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}[type];
  const expectedUrl = `${origin}/media/${digest}.${extension}`;
  if (result.url !== expectedUrl || new TextEncoder().encode(result.url).length > 256) throw Error('The upload returned an unexpected image address.');
  return result.url;
}
