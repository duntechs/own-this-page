import {ComputeBudgetProgram, PublicKey, SystemProgram, VersionedMessage, type MessageCompiledInstruction, type VersionedTransaction} from '@solana/web3.js';

type ProgramCategory = 'system' | 'compute-budget' | 'loader' | 'other';
type MessageSummary = {
  version: 'legacy' | 0 | 1;
  header: {requiredSignatures: number; readonlySignedAccounts: number; readonlyUnsignedAccounts: number};
  signatureCount: number;
  messageLength: number;
  accountCount: number;
  lookupCount: number;
  instructionCount: number;
};
type ComputeValues = {limit: number | null; priceMicroLamports: string | null};
export type SolanaWalletCompatibilityReport = {
  diagnosticVersion: 'otp-wallet-1';
  wallet: string;
  batchIndex: number;
  batchCount: number;
  expected: MessageSummary;
  returned: MessageSummary;
  firstDifferentByte: number | null;
  matches: {message: boolean; blockhash: boolean; payer: boolean; accountOrder: boolean; header: boolean; instructions: boolean; lookups: boolean};
  instructions: {index: number; expectedCategory: ProgramCategory | null; returnedCategory: ProgramCategory | null; programEqual: boolean; dataEqual: boolean; accountsEqual: boolean; expectedCompute: ComputeValues | null; returnedCompute: ComputeValues | null}[];
};

export class SolanaWalletCompatibilityError extends Error {
  constructor(public readonly report: SolanaWalletCompatibilityReport) {
    super('The wallet returned a different transaction. This attempt was not submitted. Copy the error report so we can identify the change.');
    this.name = 'SolanaWalletCompatibilityError';
  }
}

const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
function equal(a: ArrayLike<number>, b: ArrayLike<number>) {return a.length === b.length && Array.from(a).every((value, index) => value === b[index]);}
function sameKey(a: PublicKey | undefined, b: PublicKey | undefined) {return !!a && !!b && a.equals(b);}
function safeWalletName(value: string): string {
  // Wallet metadata is untrusted. Never carry URLs, control characters, or
  // arbitrary provider error strings into the copyable compatibility report.
  if (typeof value !== 'string' || /[^\x20-\x7e]|(?:https?|wss?|ftp):|www\.|[a-z0-9-]+\.[a-z]{2,}/i.test(value)) return 'Connected wallet';
  return value.replace(/[^A-Za-z0-9 _().-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 64) || 'Connected wallet';
}
function summary(message: VersionedMessage, signatureCount: number, messageLength: number): MessageSummary {
  return {version: message.version, header: {requiredSignatures: message.header.numRequiredSignatures, readonlySignedAccounts: message.header.numReadonlySignedAccounts, readonlyUnsignedAccounts: message.header.numReadonlyUnsignedAccounts}, signatureCount, messageLength,
    accountCount: message.staticAccountKeys.length, lookupCount: message.addressTableLookups.length, instructionCount: message.compiledInstructions.length};
}
function category(message: VersionedMessage, instruction: MessageCompiledInstruction): ProgramCategory {
  const key = message.staticAccountKeys[instruction.programIdIndex];
  return key?.equals(SystemProgram.programId) ? 'system' : key?.equals(ComputeBudgetProgram.programId) ? 'compute-budget' : key?.equals(loader) ? 'loader' : 'other';
}
function computeValues(message: VersionedMessage, instruction?: MessageCompiledInstruction): ComputeValues | null {
  if (!instruction || category(message, instruction) !== 'compute-budget') return null;
  const bytes = instruction.data;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {limit: bytes.length === 5 && bytes[0] === 2 ? view.getUint32(1, true) : null,
    priceMicroLamports: bytes.length === 9 && bytes[0] === 3 ? view.getBigUint64(1, true).toString() : null};
}
function sameAccount(a: VersionedMessage, aIndex: number, b: VersionedMessage, bIndex: number): boolean {
  const first = a.staticAccountKeys[aIndex], second = b.staticAccountKeys[bIndex];
  // This deployment never uses lookup tables. An unresolved returned address
  // must not be reported as equal just because its numeric index matches.
  return !!first && !!second && first.equals(second) && a.isAccountSigner(aIndex) === b.isAccountSigner(bIndex) && a.isAccountWritable(aIndex) === b.isAccountWritable(bIndex);
}

// For diagnostics only. This never decides whether a changed transaction may
// be submitted. The caller retains exact message and signature validation.
export function createSolanaWalletCompatibilityReport(options: {
  walletName: string; batchIndex: number; batchCount: number;
  expectedMessage: Uint8Array; returnedTransaction: VersionedTransaction; returnedPacket: Uint8Array;
}): SolanaWalletCompatibilityReport {
  const expectedBytes = Uint8Array.from(options.expectedMessage);
  const expected = VersionedMessage.deserialize(expectedBytes);
  const actual = options.returnedTransaction.message;
  // web3.js can parse v1 but deliberately cannot serialize it. Its wire format
  // places message bytes first and fixed-size signatures at the end.
  const actualBytes = actual.version === 1
    ? options.returnedPacket.subarray(0, options.returnedPacket.length - options.returnedTransaction.signatures.length * 64)
    : actual.serialize();
  let firstDifferentByte: number | null = null;
  const commonLength = Math.min(expectedBytes.length, actualBytes.length);
  for (let index = 0; index < commonLength; index++) if (expectedBytes[index] !== actualBytes[index]) {firstDifferentByte = index; break;}
  if (firstDifferentByte === null && expectedBytes.length !== actualBytes.length) firstDifferentByte = commonLength;
  const oldInstructions = expected.compiledInstructions, newInstructions = actual.compiledInstructions;
  const instructions = Array.from({length: Math.max(oldInstructions.length, newInstructions.length)}, (_, index) => {
    const before = oldInstructions[index], after = newInstructions[index];
    return {index, expectedCategory: before ? category(expected, before) : null, returnedCategory: after ? category(actual, after) : null,
      programEqual: !!before && !!after && sameKey(expected.staticAccountKeys[before.programIdIndex], actual.staticAccountKeys[after.programIdIndex]),
      dataEqual: !!before && !!after && equal(before.data, after.data),
      accountsEqual: !!before && !!after && before.accountKeyIndexes.length === after.accountKeyIndexes.length && before.accountKeyIndexes.every((accountIndex, position) => sameAccount(expected, accountIndex, actual, after.accountKeyIndexes[position])),
      expectedCompute: computeValues(expected, before), returnedCompute: computeValues(actual, after)};
  });
  const expectedSummary = summary(expected, expected.header.numRequiredSignatures, expectedBytes.length);
  const returnedSummary = summary(actual, options.returnedTransaction.signatures.length, actualBytes.length);
  return {diagnosticVersion: 'otp-wallet-1', wallet: safeWalletName(options.walletName), batchIndex: options.batchIndex, batchCount: options.batchCount,
    expected: expectedSummary, returned: returnedSummary, firstDifferentByte,
    matches: {message: firstDifferentByte === null, blockhash: expected.recentBlockhash === actual.recentBlockhash,
      payer: sameKey(expected.staticAccountKeys[0], actual.staticAccountKeys[0]),
      accountOrder: expected.staticAccountKeys.length === actual.staticAccountKeys.length && expected.staticAccountKeys.every((key, index) => key.equals(actual.staticAccountKeys[index])),
      header: expectedSummary.header.requiredSignatures === returnedSummary.header.requiredSignatures && expectedSummary.header.readonlySignedAccounts === returnedSummary.header.readonlySignedAccounts && expectedSummary.header.readonlyUnsignedAccounts === returnedSummary.header.readonlyUnsignedAccounts,
      instructions: oldInstructions.length === newInstructions.length && instructions.every(item => item.programEqual && item.dataEqual && item.accountsEqual),
      lookups: expected.addressTableLookups.length === actual.addressTableLookups.length && expected.addressTableLookups.every((lookup, index) => {
        const other = actual.addressTableLookups[index];
        return lookup.accountKey.equals(other.accountKey) && equal(lookup.readonlyIndexes, other.readonlyIndexes) && equal(lookup.writableIndexes, other.writableIndexes);
      })}, instructions};
}
