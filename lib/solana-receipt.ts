import {PublicKey} from '@solana/web3.js';
import {readSolanaSlots, type MarketConnection} from './solana-client';
import type {SolanaPendingReceipt} from './solana-wallet';
import catalog from './slots.json';

type ReceiptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (market: MarketConnection) => `own-page:pending:${market.config.cluster}:${market.programId.toBase58()}`;

export function readPendingReceipt(storage: ReceiptStorage, market: MarketConnection): SolanaPendingReceipt | null {
  const raw = storage.getItem(key(market));
  if (!raw) return null;
  const r = JSON.parse(raw) as SolanaPendingReceipt;
  if (!r || r.cluster !== market.config.cluster || r.programId !== market.programId.toBase58() ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(r.signature) ||
      !Number.isSafeInteger(r.lastValidBlockHeight) || r.lastValidBlockHeight < 0 ||
      !Number.isInteger(r.slotId) || r.slotId < 0 || r.slotId >= catalog.length ||
      new PublicKey(r.actor).toBase58() !== r.actor) throw Error('The saved transaction receipt is invalid. Check your wallet history before continuing.');
  return r;
}

export function savePendingReceipt(storage: ReceiptStorage, market: MarketConnection, receipt: SolanaPendingReceipt) {
  const existing = readPendingReceipt(storage, market);
  if (existing && existing.signature !== receipt.signature) throw Error('Resolve the saved transaction before starting another payment.');
  const serialized = JSON.stringify(receipt);
  storage.setItem(key(market), serialized);
  if (storage.getItem(key(market)) !== serialized) throw Error('Unable to save the transaction receipt. Nothing was submitted.');
}

export function clearPendingReceipt(storage: ReceiptStorage, market: MarketConnection) {storage.removeItem(key(market));}

export async function inspectPendingReceipt(market: MarketConnection, receipt: SolanaPendingReceipt): Promise<'confirmed' | 'failed' | 'pending' | 'expired'> {
  if (receipt.cluster !== market.config.cluster || receipt.programId !== market.programId.toBase58()) throw Error('The saved transaction belongs to a different marketplace.');
  const result = await market.connection.getSignatureStatuses([receipt.signature], {searchTransactionHistory: true});
  if (result.value.length !== 1) throw Error('The transaction status response is incomplete.');
  const status = result.value[0];
  const settled = status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized';
  if (settled) return status.err ? 'failed' : 'confirmed';
  if (status) return 'pending';
  // A missing receipt is not failure. Only a finalized expiry plus a fresh
  // second status read permits a new review. No payment is automatically retried.
  const finalized = await market.connection.getEpochInfo('finalized');
  if (!Number.isSafeInteger(finalized.blockHeight) || !Number.isSafeInteger(finalized.absoluteSlot) || finalized.blockHeight! <= receipt.lastValidBlockHeight) return 'pending';
  const after = await market.connection.getSignatureStatuses([receipt.signature], {searchTransactionHistory: true});
  if (after.value.length !== 1) throw Error('The transaction status response is incomplete.');
  const latest = after.value[0];
  if (latest?.confirmationStatus === 'confirmed' || latest?.confirmationStatus === 'finalized') return latest.err ? 'failed' : 'confirmed';
  if (latest || !Number.isSafeInteger(after.context.slot) || after.context.slot < finalized.absoluteSlot) return 'pending';
  await readSolanaSlots(market, [receipt.slotId], finalized.absoluteSlot);
  return 'expired';
}
