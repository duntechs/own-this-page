import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvedSolanaPrices, baseLamports} from '../lib/solana-pricing.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [binaryArgument, outputArgument] = process.argv.slice(2);
assert(binaryArgument && outputArgument, 'Usage: node scripts/solana-build-manifest.mjs PROGRAM_SO OUTPUT_DIRECTORY');
const binaryPath = resolve(binaryArgument);
const outputDirectory = resolve(outputArgument);
const [binary, catalogBytes, programSource, cargoLock] = await Promise.all([
  readFile(binaryPath), readFile(resolve(root, 'lib/slots.json')),
  readFile(resolve(root, 'solana-market/src/lib.rs'), 'utf8'),
  readFile(resolve(root, 'solana-market/Cargo.lock')),
]);
assert(binary.length > 64 && binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), 'Expected a compiled ELF program');
// Solana's loader accepts EM_BPF (247) and EM_SBPF (263). Both exclude a native
// x86/ARM .so accidentally supplied in place of the program.
assert.equal(binary[4], 2, 'Expected ELF64');
assert.equal(binary[5], 1, 'Expected little-endian ELF');
assert([247, 263].includes(binary.readUInt16LE(18)), 'Expected Solana BPF ELF machine');
const treasury = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';
assert(programSource.includes(`pub const TREASURY: Pubkey = pubkey!("${treasury}")`), 'Program treasury must match the approved project wallet');
const slots = JSON.parse(catalogBytes.toString('utf8'));
assert.equal(slots.length, 62, 'Own This Page must contain 62 buyable spaces');
const prices = slots.map((slot, id) => {
  assert.equal(slot.id, id, 'Slot IDs must remain contiguous');
  return {id, key: slot.key, baseLamports: baseLamports(slot).toString()};
});
assert.equal(prices.some(slot => /coin-ca|official-x/.test(slot.key)), false, 'Official identity must never become an advertiser slot');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourcePaths = [
  'solana-market/Cargo.toml',
  'solana-market/build.rs',
  'solana-market/src/lib.rs',
  'solana-market/Cargo.lock',
  'lib/slots.json',
  'lib/solana-pricing.ts',
];
const sourceSha256 = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha256(await readFile(resolve(root, path)))])));
const manifest = {
  schemaVersion: 1,
  project: 'Own This Page',
  network: 'solana',
  programFile: 'slot_market.so',
  programSha256: sha256(binary),
  programLength: binary.length,
  sourceCommit: process.env.GITHUB_SHA || null,
  toolchain: {agave: '2.2.20', platformTools: 'v1.48'},
  treasury, admin: treasury,
  pricing: approvedSolanaPrices,
  slotCount: slots.length,
  catalogSha256: sha256(catalogBytes),
  cargoLockSha256: sha256(cargoLock),
  sourceSha256,
  prices,
  deployment: {programId: null, initialized: false},
};
await mkdir(outputDirectory, {recursive: true});
await copyFile(binaryPath, resolve(outputDirectory, 'slot_market.so'));
await copyFile(resolve(root, 'solana-market/Cargo.lock'), resolve(outputDirectory, 'Cargo.lock'));
await writeFile(resolve(outputDirectory, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Prepared tested Solana program: ${binary.length} bytes, SHA256 ${manifest.programSha256}. No on-chain deployment was performed.`);
