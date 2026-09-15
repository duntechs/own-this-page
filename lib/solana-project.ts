import {approvedSolanaPrices, isApprovedSolanaPrices, type SolanaPrices} from './solana-pricing';
import {officialProject} from './official-project';

export type SolanaProjectConfig = {
  network: 'solana';
  cluster: 'mainnet-beta';
  rpc: string;
  devWallet: string;
  treasury: string;
  admin: string;
  mint: string;
  programId: string;
  programSha256: string;
  programLength: number;
  enabled: boolean;
  prices: SolanaPrices;
  automaticCoinDetection: false;
};

const projectWallet = '8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9';

export function isSolanaPublicKey(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let decoded = BigInt(0);
  for (const character of value) decoded = decoded * BigInt(58) + BigInt(alphabet.indexOf(character));
  let bytes = 0;
  for (let remaining = decoded; remaining > BigInt(0); remaining >>= BigInt(8)) bytes++;
  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  return bytes + leadingZeroBytes === 32;
}

// RPC endpoints are published to every visitor. Require an HTTPS DNS hostname,
// with no embedded credentials or local/IP-literal endpoints. This is a URL
// schema check, not proof of endpoint identity, DNS routing, or chain state.
export function isPublicHttpsRpc(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > 2048) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    if ([...url.searchParams.keys()].some(key => /^(?:api[-_]?key|key|token|access[-_]?token|authorization)$/i.test(key))) return false;
    const host = url.hostname.toLowerCase();
    const labels = host.split('.');
    if (labels.length < 2 || !/^[a-z]{2,63}$/.test(labels.at(-1) ?? '')) return false;
    if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
    if (/(?:^|\.)(?:localhost|local|internal|invalid|test|example)$/.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

// These are public project settings. SOL payments require a separately deployed
// and verified market program; a coin mint is never a payment program address.
export const solanaProject: Readonly<SolanaProjectConfig> = Object.freeze({
  network: 'solana',
  cluster: 'mainnet-beta',
  rpc: 'https://ownthispage.page/api/rpc',
  devWallet: projectWallet,
  treasury: projectWallet,
  admin: projectWallet,
  mint: officialProject.coinAddress,
  programId: '',
  programSha256: '',
  programLength: 0,
  enabled: false,
  prices: approvedSolanaPrices,
  automaticCoinDetection: false,
});

export function solanaDeploymentConfig(saved: unknown = solanaProject): SolanaProjectConfig {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    throw Error('Invalid Solana project configuration.');
  }
  const candidate = saved as Record<string, unknown>;
  if (!isSolanaPublicKey(projectWallet)) throw Error('The configured Solana wallet must decode to 32 bytes.');
  if (solanaProject.mint && (!isSolanaPublicKey(solanaProject.mint) || solanaProject.mint === projectWallet)) {
    throw Error('The owner-published token mint must be a valid Solana address distinct from the project wallet.');
  }
  for (const field of ['network', 'cluster', 'devWallet', 'treasury', 'admin'] as const) {
    if (candidate[field] !== undefined && candidate[field] !== solanaProject[field]) {
      throw Error(`Unexpected Solana project ${field}.`);
    }
  }
  if (!isApprovedSolanaPrices(candidate.prices)) {
    throw Error('The approved Solana starting-price schedule is required.');
  }
  for (const field of ['mint', 'automaticCoinDetection'] as const) {
    if (candidate[field] !== undefined && candidate[field] !== solanaProject[field]) {
      throw Error(`Unexpected owner-approved Solana project ${field}.`);
    }
  }
  const rpc = candidate.rpc === undefined ? solanaProject.rpc : candidate.rpc;
  if (!isPublicHttpsRpc(rpc)) throw Error('The Solana RPC must be a public HTTPS URL without embedded credentials.');
  const programId = candidate.programId === undefined ? '' : candidate.programId;
  const programSha256 = candidate.programSha256 === undefined ? '' : candidate.programSha256;
  const programLength = candidate.programLength === undefined ? 0 : candidate.programLength;
  const enabled = candidate.enabled === undefined ? false : candidate.enabled;
  if (typeof enabled !== 'boolean') throw Error('Solana payment activation must be a boolean.');
  if (typeof programId !== 'string' || typeof programSha256 !== 'string' || typeof programLength !== 'number') {
    throw Error('Invalid Solana marketplace program identity.');
  }
  const hasProgram = programId !== '' || programSha256 !== '' || programLength !== 0;
  if (hasProgram) {
    if (!isSolanaPublicKey(programId) || programId === projectWallet ||
        !/^[0-9a-f]{64}$/.test(programSha256) || !Number.isInteger(programLength) ||
        programLength <= 0 || programLength > 4 * 1024 * 1024) {
      throw Error('A marketplace program requires a valid distinct program ID, SHA-256 hash, and byte length up to 4 MiB.');
    }
  } else if (enabled) {
    throw Error('Solana payments require a complete marketplace program identity.');
  }
  // This checks configuration shape only. The deployment gate and wallet client
  // must independently verify the on-chain program and its exact executable bytes
  // before publishing an enabled deployment or requesting any transaction.
  // Never spread an uploaded configuration or read legacy activation environment
  // variables here. Neither may restore EVM payments or announce an unknown mint.
  return {...solanaProject, rpc, programId, programSha256, programLength, enabled};
}
