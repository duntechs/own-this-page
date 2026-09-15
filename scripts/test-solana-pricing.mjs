import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.sites-runtime/solana-pricing-tests');
await build({
  configFile: false, root, logLevel: 'silent',
  build: {
    ssr: path.join(root, 'lib/solana-pricing.ts'), outDir: output, emptyOutDir: true,
    rollupOptions: {output: {entryFileNames: 'pricing.mjs'}},
  },
});
const {approvedSolanaPrices, baseLamports, quoteLamports, takeoverLamports, formatSol} = await import(pathToFileURL(path.join(output, 'pricing.mjs')).href);
const catalog = JSON.parse(await readFile(path.join(root, 'lib/slots.json'), 'utf8'));
let passed = 0;
function check(name, run) {run(); console.log('PASS ' + name); passed++;}

check('the schedule uses the owner-approved 0.1–2 SOL endpoints and 0.001 SOL increments', () => {
  assert.deepEqual(approvedSolanaPrices, {
    currency: 'SOL', minimumLamports: '100000000', maximumLamports: '2000000000',
    incrementLamports: '1000000', model: 'fixed-area-linear-v1',
  });
  assert.equal(baseLamports({width: 40, height: 40}), 100000000n);
  assert.equal(baseLamports({width: 600, height: 440}), 2000000000n);
  assert.equal(baseLamports({width: 400, height: 332}), 1050000000n, 'the midpoint area must receive the midpoint price');
});

check('all 62 fixed design areas have monotone prices and equal areas have equal prices', () => {
  assert.equal(catalog.length, 62);
  const sorted = [...catalog].sort((a, b) => a.width * a.height - b.width * b.height);
  assert.equal(sorted[0].width * sorted[0].height, 1600);
  assert.equal(sorted.at(-1).width * sorted.at(-1).height, 264000);
  let previousArea = 0;
  let previousPrice = 0n;
  for (const slot of sorted) {
    const price = baseLamports(slot);
    assert(price >= 100000000n && price <= 2000000000n, slot.key);
    assert.equal(price % 1000000n, 0n, slot.key);
    assert(price >= previousPrice, slot.key);
    const area = slot.width * slot.height;
    if (area === previousArea) assert.equal(price, previousPrice, slot.key);
    assert.equal(baseLamports({...slot, baseWei: '99999999999999999999999'}), price, 'EVM prices have no effect');
    assert.equal(quoteLamports(slot), price);
    previousArea = area;
    previousPrice = price;
  }
});

check('integer rounding uses half-up increments and clamps only initial design-area prices', () => {
  assert.equal(baseLamports({width: 2911, height: 1}), 109000000n);
  assert.equal(baseLamports({width: 2912, height: 1}), 110000000n, 'exact half-step rounds up');
  assert.equal(baseLamports({width: 2913, height: 1}), 110000000n);
  assert.equal(baseLamports({width: 1, height: 1}), 100000000n);
  assert.equal(baseLamports({width: Number.MAX_SAFE_INTEGER, height: Number.MAX_SAFE_INTEGER}), 2000000000n);
  for (const width of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '40']) {
    assert.throws(() => baseLamports({width, height: 40}));
  }
  assert.throws(() => baseLamports({width: 40, height: 0}));
});

check('takeovers double the actual last payment beyond 2 SOL without floating point or u64 overflow', () => {
  const slot = {width: 600, height: 440};
  assert.equal(quoteLamports(slot, 2000000000n), 4000000000n);
  assert.equal(quoteLamports(slot, 4000000000n), 8000000000n);
  assert.equal(takeoverLamports(100000001n), 200000002n);
  const maximumU64 = (1n << 64n) - 1n;
  assert.equal(takeoverLamports(maximumU64 / 2n), maximumU64 - 1n);
  assert.throws(() => takeoverLamports(maximumU64 / 2n + 1n));
  for (const value of [0n, -1n, maximumU64 + 1n, 0.1, '100000000']) {
    assert.throws(() => takeoverLamports(value));
  }
  assert.throws(() => quoteLamports(slot, -1n));
});

check('SOL formatting preserves exact lamports, including amounts above JavaScript safe integers', () => {
  assert.equal(formatSol(0n), '0');
  assert.equal(formatSol(1n), '0.000000001');
  assert.equal(formatSol(100000000n), '0.1');
  assert.equal(formatSol(1050000000n), '1.05');
  assert.equal(formatSol(2000000000n), '2');
  assert.equal(formatSol((1n << 64n) - 1n), '18446744073.709551615');
  assert.throws(() => formatSol(-1n));
  assert.throws(() => formatSol(100000000));
});

console.log(`${passed} SOL pricing checks passed. No network request or wallet transaction was made.`);
