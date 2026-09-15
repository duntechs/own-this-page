// Owner-approved initial prices. This is an independent SOL schedule, not a
// conversion of the historical EVM catalog's baseWei values.
export const approvedSolanaPrices = Object.freeze({
  currency: 'SOL',
  minimumLamports: '100000000',
  maximumLamports: '2000000000',
  incrementLamports: '1000000',
  model: 'fixed-area-linear-v1',
} as const);

export type SolanaPrices = typeof approvedSolanaPrices;
export type SlotDimensions = {width: number; height: number};

const minimumArea = BigInt(1600);
const maximumArea = BigInt(264000);
const minimum = BigInt(approvedSolanaPrices.minimumLamports);
const maximum = BigInt(approvedSolanaPrices.maximumLamports);
const increment = BigInt(approvedSolanaPrices.incrementLamports);
const lamportsPerSol = BigInt(1000000000);
const maximumU64 = (BigInt(1) << BigInt(64)) - BigInt(1);

function checkedLamports(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < BigInt(0) || value > maximumU64) {
    throw Error('Lamports must be an unsigned 64-bit integer.');
  }
  return value;
}

// Pricing uses fixed catalog dimensions, never the visitor's screen dimensions.
// Clamp the design area to the catalog endpoints, interpolate, and round half up
// to 0.001 SOL using integer arithmetic. Equal areas always have equal prices.
export function baseLamports(slot: SlotDimensions): bigint {
  if (!Number.isSafeInteger(slot.width) || !Number.isSafeInteger(slot.height) || slot.width <= 0 || slot.height <= 0) {
    throw Error('Slot dimensions must be positive safe integers.');
  }
  const area = BigInt(slot.width) * BigInt(slot.height);
  const clampedArea = area < minimumArea ? minimumArea : area > maximumArea ? maximumArea : area;
  const numerator = (clampedArea - minimumArea) * (maximum - minimum);
  const denominator = (maximumArea - minimumArea) * increment;
  const steps = (numerator + denominator / BigInt(2)) / denominator;
  return minimum + steps * increment;
}

// The 2 SOL maximum is an initial-price limit, not a takeover-price cap.
export function takeoverLamports(lastPaid: bigint): bigint {
  checkedLamports(lastPaid);
  if (lastPaid === BigInt(0)) throw Error('A takeover requires a previous purchase.');
  if (lastPaid > maximumU64 / BigInt(2)) throw Error('The doubled takeover price exceeds the u64 lamport limit.');
  return lastPaid * BigInt(2);
}

export function quoteLamports(slot: SlotDimensions, lastPaid: bigint = BigInt(0)): bigint {
  checkedLamports(lastPaid);
  return lastPaid === BigInt(0) ? baseLamports(slot) : takeoverLamports(lastPaid);
}

export function formatSol(lamports: bigint): string {
  checkedLamports(lamports);
  const whole = lamports / lamportsPerSol;
  const fraction = (lamports % lamportsPerSol).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function isApprovedSolanaPrices(value: unknown): value is SolanaPrices {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const fields = Object.keys(approvedSolanaPrices) as (keyof SolanaPrices)[];
  return Object.keys(candidate).length === fields.length && fields.every(field => candidate[field] === approvedSolanaPrices[field]);
}
