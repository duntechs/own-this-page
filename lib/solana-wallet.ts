import {Buffer} from 'buffer';
import {getWallets} from '@wallet-standard/app';
import {PublicKey, Transaction, VersionedTransaction} from '@solana/web3.js';
import {buildSolanaTransaction, SLOT_ACCOUNT_SIZE, withSolanaTimeout, readSolanaSlots, sameSolanaQuote, verifySolanaProgram, type PreparedSolanaAction, type SolanaCluster} from './solana-client';
import {createSolanaWalletCompatibilityReport, SolanaWalletCompatibilityError} from './solana-wallet-diagnostics';

type StandardWallet = ReturnType<ReturnType<typeof getWallets>['get']>[number];
type StandardAccount = StandardWallet['accounts'][number];
type ConnectFeature = {connect(input?: {silent?: boolean}): Promise<{accounts: readonly StandardAccount[]}>};
type EventsFeature = {on(event: 'change', listener: (change: {accounts?: readonly StandardAccount[]}) => void): () => void};
type SignFeature = {supportedTransactionVersions: readonly ('legacy' | number)[]; signTransaction(...inputs: {transaction: Uint8Array; account: StandardAccount; chain: string}[]): Promise<readonly {signedTransaction: Uint8Array}[]>};
export type SolanaWallet = StandardWallet;
export type SolanaWalletSession = {wallet: SolanaWallet; account: StandardAccount; cluster: SolanaCluster};
export class SolanaSubmissionError extends Error {
  constructor(message: string, public readonly signature: string | null = null) {super(message); this.name = 'SolanaSubmissionError';}
}

// Encoding only; the SDK verifies Ed25519 signatures. Preserve the deterministic
// transaction ID before sending, including when the RPC loses its response.
export function encodeSolanaSignature(signature: Uint8Array): string {
  if (signature.length !== 64) throw Error('A Solana transaction signature must contain 64 bytes.');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let value = BigInt(0);
  for (const byte of signature) value = (value << BigInt(8)) + BigInt(byte);
  let output = '';
  while (value > BigInt(0)) {output = alphabet[Number(value % BigInt(58))] + output; value /= BigInt(58);}
  for (const byte of signature) {if (byte !== 0) break; output = '1' + output;}
  return output;
}
const chain = (cluster: SolanaCluster) => cluster === 'mainnet-beta' ? 'solana:mainnet' : 'solana:devnet';
function features(wallet: StandardWallet) {
  return {connect: wallet.features['standard:connect'] as ConnectFeature | undefined,
    events: wallet.features['standard:events'] as EventsFeature | undefined,
    sign: wallet.features['solana:signTransaction'] as SignFeature | undefined};
}
function usable(wallet: StandardWallet, cluster: SolanaCluster): boolean {
  const f = features(wallet);
  return wallet.chains.includes(chain(cluster) as `${string}:${string}`) && typeof f.connect?.connect === 'function' && typeof f.events?.on === 'function' && typeof f.sign?.signTransaction === 'function' && f.sign.supportedTransactionVersions.includes('legacy');
}
function matchingAccount(account: StandardAccount, cluster: SolanaCluster): boolean {
  try {
    return account.chains.includes(chain(cluster) as `${string}:${string}`) && account.features.includes('solana:signTransaction') && new PublicKey(account.address).toBase58() === account.address && new PublicKey(account.publicKey).toBase58() === account.address;
  } catch {return false;}
}
function currentAccount(session: SolanaWalletSession): StandardAccount {
  if (!usable(session.wallet, session.cluster)) throw Error('This wallet no longer supports the selected Solana network.');
  const account = session.wallet.accounts.find(candidate => candidate.address === session.account.address && matchingAccount(candidate, session.cluster));
  if (!account) throw Error('Your wallet account changed or disconnected. Connect again before continuing.');
  return account;
}

// Discovery and event subscription never open a wallet prompt.
export function listSolanaWallets(cluster: SolanaCluster = 'mainnet-beta'): SolanaWallet[] {
  if (typeof window === 'undefined') return [];
  return getWallets().get().filter(wallet => usable(wallet, cluster));
}
export function onSolanaWalletsChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const wallets = getWallets();
  const offRegister = wallets.on('register', listener);
  const offUnregister = wallets.on('unregister', listener);
  return () => {offRegister(); offUnregister();};
}
export async function connectSolanaWallet(wallet: SolanaWallet, cluster: SolanaCluster = 'mainnet-beta'): Promise<SolanaWalletSession> {
  if (!usable(wallet, cluster)) throw Error('Choose a Solana wallet that supports transaction signing on this network.');
  const result = await features(wallet).connect!.connect();
  const account = result.accounts.find(candidate => matchingAccount(candidate, cluster));
  if (!account) throw Error('The wallet did not provide a compatible Solana account.');
  const session = {wallet, account, cluster};
  currentAccount(session);
  return session;
}
export function onSolanaAccountChange(session: SolanaWalletSession, listener: (session: SolanaWalletSession | null) => void): () => void {
  return features(session.wallet).events!.on('change', () => {
    try {listener({...session, account: currentAccount(session)});} catch {listener(null);}
  });
}
export async function disconnectSolanaWallet(session: SolanaWalletSession): Promise<void> {
  const disconnect = session.wallet.features['standard:disconnect'] as {disconnect(): Promise<void>} | undefined;
  if (typeof disconnect?.disconnect === 'function') await disconnect.disconnect();
}

export function verifySignedSolanaTransaction(expected: Transaction, signedBytes: Uint8Array, address: string): Transaction {
  if (signedBytes.length > 1232) throw Error('The wallet returned an oversized transaction.');
  const signed = Transaction.from(signedBytes);
  if (!Buffer.from(signed.serializeMessage()).equals(expected.serializeMessage()) || signed.feePayer?.toBase58() !== address) throw Error('The wallet changed the transaction. Nothing was submitted.');
  if (!signed.verifySignatures() || signed.signatures.length !== 1 || signed.signatures[0].publicKey.toBase58() !== address) throw Error('The wallet did not return the required valid signature.');
  return signed;
}

// Used only by the explicit owner deployment flow. It accepts transactions
// already partially signed by temporary program/buffer keypairs. Some wallets
// return only their own signature; restore missing validated co-signatures only
// after checking the identical message and the returned wallet signature.
export function createSolanaDeploymentSigner(session: SolanaWalletSession) {
  async function signTransactions(transactions: Transaction[]): Promise<Transaction[]> {
    if (transactions.length < 1 || transactions.length > 5) throw Error('Sign between one and five deployment transactions at a time.');
    const account = currentAccount(session);
    const originals = transactions.map(transaction => {
      if (transaction.feePayer?.toBase58() !== account.address) throw Error('The deployment fee payer does not match the connected wallet.');
      const message = Buffer.from(transaction.serializeMessage());
      const signatures = transaction.signatures.filter(item => item.signature).map(item => ({publicKey: item.publicKey.toBase58(), signature: Buffer.from(item.signature!)}));
      if (!transaction.verifySignatures(false)) throw Error('The deployment has an invalid existing signature.');
      return {message, signatures, bytes: Uint8Array.from(transaction.serialize({requireAllSignatures: false}))};
    });
    const output = await features(session.wallet).sign!.signTransaction(...originals.map(original => ({transaction: original.bytes, account, chain: chain(session.cluster)})));
    currentAccount(session);
    if (output.length !== transactions.length) throw Error('The wallet returned an incomplete deployment batch.');
    return output.map((item, index) => {
      if (item.signedTransaction.length > 1232) throw Error('The wallet returned an oversized deployment transaction.');
      const signed = Transaction.from(item.signedTransaction);
      if (!Buffer.from(signed.serializeMessage()).equals(originals[index].message)) throw Error('The wallet changed the deployment transaction message. Nothing was submitted.');
      const walletSignature = signed.signatures.find(item => item.publicKey.toBase58() === account.address)?.signature;
      // Never restore the connected wallet's signature from the input: the
      // wallet must return it for this explicit approval request.
      if (!walletSignature) throw Error('The wallet did not return its deployment signature. Nothing was submitted.');
      if (!signed.verifySignatures(false)) throw Error('The wallet returned an invalid deployment signature. Nothing was submitted.');
      for (const original of originals[index].signatures) {
        const after = signed.signatures.find(item => item.publicKey.toBase58() === original.publicKey)?.signature;
        if (after) {
          if (!Buffer.from(after).equals(original.signature)) throw Error('The wallet changed an existing deployment signature. Nothing was submitted.');
        } else if (original.publicKey !== account.address) {
          signed.addSignature(new PublicKey(original.publicKey), original.signature);
        }
      }
      if (!signed.verifySignatures()) throw Error('A required deployment co-signature is missing. Nothing was submitted.');
      return signed;
    });
  }
  return {
    publicKey: new PublicKey(session.account.address),
    assertCurrentAccount() {currentAccount(session);},
    signTransactions,
    async signTransaction(transaction: Transaction): Promise<Transaction> {return (await signTransactions([transaction]))[0];},
  };
}

// Deployment uses frozen v0 messages and seeded accounts. The owner is the only
// signer: no ephemeral account signatures need restoring or recompiling.
export function createVersionedSolanaDeploymentSigner(session: SolanaWalletSession) {
  async function signTransactions(transactions: VersionedTransaction[]): Promise<VersionedTransaction[]> {
    const account = currentAccount(session);
    if (!features(session.wallet).sign!.supportedTransactionVersions.includes(0)) throw Error('This wallet must support Solana version 0 transactions to deploy the marketplace.');
    if (transactions.length < 1 || transactions.length > 5) throw Error('Review one to five deployment transactions at a time.');
    const messages = transactions.map(transaction => {
      if (transaction.version !== 0 || transaction.message.header.numRequiredSignatures !== 1 ||
          transaction.message.staticAccountKeys[0].toBase58() !== account.address || transaction.message.addressTableLookups.length) {
        throw Error('The deployment must use the connected wallet as its only signer.');
      }
      if (transaction.signatures.some(signature => signature.some(byte => byte !== 0))) throw Error('The deployment request already has a signature.');
      return Uint8Array.from(transaction.message.serialize());
    });
    const packets = transactions.map((transaction, index) => {
      const packet = Uint8Array.from(transaction.serialize());
      const roundTrip = VersionedTransaction.deserialize(packet);
      if (roundTrip.version !== 0 || roundTrip.signatures.length !== 1 || !Buffer.from(roundTrip.message.serialize()).equals(Buffer.from(messages[index])) || roundTrip.signatures.some(signature => signature.some(byte => byte !== 0))) {
        throw Error('The deployment transaction could not be encoded consistently. No wallet approval was requested.');
      }
      return packet;
    });
    const output = await withSolanaTimeout(features(session.wallet).sign!.signTransaction(...packets.map(transaction => ({
      transaction, account, chain: chain(session.cluster),
    }))), 90_000);
    currentAccount(session);
    if (output.length !== transactions.length) throw Error('The wallet returned an incomplete deployment batch. Nothing was submitted.');
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(account.publicKey), {name: 'Ed25519'}, false, ['verify']);
    const signed = await Promise.all(output.map(async (item, index) => {
      if (item.signedTransaction.length > 1232) throw Error('The wallet returned an oversized transaction.');
      const transaction = VersionedTransaction.deserialize(item.signedTransaction);
      // The browser Buffer polyfill requires both operands to be Buffers.
      // Node also accepts Uint8Array, so SSR tests alone miss this boundary.
      if (transaction.version !== 0 || !Buffer.from(transaction.message.serialize()).equals(Buffer.from(messages[index])) || transaction.signatures.length !== 1) {
        throw new SolanaWalletCompatibilityError(createSolanaWalletCompatibilityReport({walletName: session.wallet.name, batchIndex: index, batchCount: transactions.length,
          expectedMessage: messages[index], returnedTransaction: transaction, returnedPacket: item.signedTransaction}));
      }
      if (!await crypto.subtle.verify({name: 'Ed25519'}, key, Uint8Array.from(transaction.signatures[0]), messages[index])) {
        throw Error('The wallet did not return a valid deployment signature. Nothing was submitted.');
      }
      return transaction;
    }));
    currentAccount(session);
    return signed;
  }
  return {publicKey: new PublicKey(session.account.address), assertCurrentAccount() {currentAccount(session);}, signTransactions};
}

export async function signSolanaImageUpload(session: SolanaWalletSession, message: Uint8Array): Promise<Uint8Array> {
  const account = currentAccount(session);
  const feature = session.wallet.features['solana:signMessage'] as {signMessage(...inputs: {account: StandardAccount; message: Uint8Array}[]): Promise<readonly {signedMessage: Uint8Array; signature: Uint8Array}[]>} | undefined;
  if (!feature?.signMessage || !account.features.includes('solana:signMessage')) throw Error('This wallet does not support image upload authorization. You can use an existing image link instead.');
  const expected = Uint8Array.from(message);
  const output = await withSolanaTimeout(feature.signMessage({account, message: Uint8Array.from(expected)}), 90_000);
  currentAccount(session);
  if (output.length !== 1 || !Buffer.from(output[0].signedMessage).equals(Buffer.from(expected)) || output[0].signature.length !== 64) throw Error('The wallet changed the image upload authorization.');
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(account.publicKey), {name: 'Ed25519'}, false, ['verify']);
  if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(output[0].signature), expected)) throw Error('The image upload signature is invalid.');
  currentAccount(session);
  return Uint8Array.from(output[0].signature);
}

// Call only from an explicit confirmation click after displaying the prepared
// price, account rent, and network fee. Never sign a message or submit a separate
// transfer as a substitute for the program's atomic purchase instruction.
export type SolanaPendingReceipt = {signature: string; lastValidBlockHeight: number; cluster: SolanaCluster; programId: string; actor: string; slotId: number};
export async function signAndSendSolanaTransaction(session: SolanaWalletSession, prepared: PreparedSolanaAction, timeoutMs = 60_000, beforeBroadcast?: (receipt: SolanaPendingReceipt) => void): Promise<string> {
  if (session.cluster !== prepared.market.config.cluster || session.account.address !== prepared.action.actor) throw Error('The connected wallet does not match this transaction.');
  const account = currentAccount(session);
  const intended = buildSolanaTransaction(prepared.market, prepared.action, prepared, prepared.priorityMicroLamports);
  if (!Buffer.from(prepared.transaction.serializeMessage()).equals(intended.serializeMessage())) throw Error('The prepared transaction does not match the slot action.');
  const market = prepared.market;
  const verified = await verifySolanaProgram(market);
  const fresh = await readSolanaSlots(market, [prepared.action.id], Math.max(prepared.contextSlot, verified.contextSlot));
  if (!sameSolanaQuote(prepared.action.expected, fresh.states[0])) throw Error('The slot changed. Refresh the quote before signing.');
  const rent = fresh.states[0].exists ? 0 : await market.connection.getMinimumBalanceForRentExemption(SLOT_ACCOUNT_SIZE, 'confirmed');
  if (!Number.isSafeInteger(rent) || rent < 0 || BigInt(rent) - fresh.accountLamports[0] > prepared.rentLamports) throw Error('The account deposit changed. Review the transaction again.');
  // Review time must not consume the signing window. Keep the exact payment,
  // recipients and priority instructions; refresh only the unsigned blockhash.
  const recent = await market.connection.getLatestBlockhash({commitment: 'confirmed', minContextSlot: fresh.contextSlot});
  const transaction = buildSolanaTransaction(market, prepared.action, recent, prepared.priorityMicroLamports);
  const fee = await market.connection.getFeeForMessage(transaction.compileMessage(), 'confirmed');
  if (!Number.isSafeInteger(fee.value) || fee.value === null || fee.value < 0 || BigInt(fee.value) > prepared.feeLamports) throw Error('The network fee increased. Review the transaction again.');
  const balance = await market.connection.getBalance(new PublicKey(account.address), {commitment: 'confirmed', minContextSlot: fresh.contextSlot});
  if (!Number.isSafeInteger(balance) || balance < 0 || BigInt(balance) < prepared.paymentLamports + prepared.rentLamports + BigInt(fee.value)) throw Error('Your wallet no longer has enough SOL for this reviewed transaction.');
  const expectedMessage = Buffer.from(transaction.serializeMessage());
  const result = await withSolanaTimeout(features(session.wallet).sign!.signTransaction({
    transaction: Uint8Array.from(transaction.serialize({requireAllSignatures: false, verifySignatures: false})),
    account, chain: chain(session.cluster),
  }), 120_000);
  currentAccount(session);
  if (result.length !== 1 || !Buffer.from(transaction.serializeMessage()).equals(expectedMessage)) throw Error('The transaction changed while the wallet was open. Nothing was submitted.');
  const signed = verifySignedSolanaTransaction(transaction, result[0].signedTransaction, account.address);
  await verifySolanaProgram(market);
  if (await market.connection.getBlockHeight('confirmed') > recent.lastValidBlockHeight) throw Error('The wallet approval took too long and this transaction expired. Nothing was submitted. Review it again.');
  const signature = encodeSolanaSignature(signed.signature!);
  // Persist the public receipt BEFORE broadcasting, so reloads cannot hide an
  // ambiguous payment. A storage failure stops submission.
  beforeBroadcast?.({signature, lastValidBlockHeight: recent.lastValidBlockHeight, cluster: session.cluster, programId: market.programId.toBase58(), actor: account.address, slotId: prepared.action.id});
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1000), 90_000);
  const bounded = <T>(promise: Promise<T>) => withSolanaTimeout(promise, Math.min(15_000, Math.max(1, deadline - Date.now())));
  try {
    const returnedSignature = await bounded(market.connection.sendRawTransaction(signed.serialize(), {skipPreflight: false, preflightCommitment: 'confirmed', minContextSlot: fresh.contextSlot, maxRetries: 3}));
    if (returnedSignature !== signature) throw new SolanaSubmissionError('The RPC returned a different transaction ID. Check the locally signed transaction before trying again.', signature);
    while (Date.now() < deadline) {
      const statuses = await bounded(market.connection.getSignatureStatuses([signature], {searchTransactionHistory: true}));
      const status = statuses.value[0];
      if (status?.err) throw new SolanaSubmissionError('The transaction reported an error. Check its confirmed receipt before trying again.', signature);
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return signature;
      if (await bounded(market.connection.getBlockHeight('confirmed')) > recent.lastValidBlockHeight) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(1500, Math.max(1, deadline - Date.now()))));
    }
    throw new SolanaSubmissionError('Confirmation is still unknown. Your transaction ID is saved. Check its status before starting another payment.', signature);
  } catch (error) {
    if (error instanceof SolanaSubmissionError) throw error;
    throw new SolanaSubmissionError('The connection timed out or could not confirm the result. Your transaction ID is saved; check its status before another payment.', signature);
  }
}
