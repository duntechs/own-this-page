import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';

// Only an independently pinned release may be offered to a signing wallet.
// Neither a build environment variable nor a changed manifest can select code.
const expectedHash = '0bfd88426f4163f805d8b39026e145c2d0baa66063223a87e27e75a148c7c3bf';
const binary = await readFile(new URL('../solana-market/artifacts/slot_market.so', import.meta.url));
if (binary.length !== 105016 || createHash('sha256').update(binary).digest('hex') !== expectedHash) throw Error('The marketplace release does not match the approved binary.');
const manifest = JSON.parse(await readFile(new URL('../solana-market/artifacts/build-manifest.json', import.meta.url), 'utf8'));
if (manifest.programSha256 !== expectedHash || manifest.programLength !== binary.length || manifest.slotCount !== 62 || manifest.treasury !== '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9') throw Error('The marketplace release manifest changed.');
const output = new URL('../public/deployment/', import.meta.url);
await mkdir(output, {recursive: true});
await writeFile(new URL('slot_market.so', output), binary);
console.log('Verified 62-space deployment artifact; no wallet or network transaction requested.');
