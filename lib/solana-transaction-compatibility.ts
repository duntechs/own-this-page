import {VersionedMessage, type MessageCompiledInstruction} from '@solana/web3.js';

export const LIGHTHOUSE_PROGRAM_ADDRESS = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export type SolanaTransactionCompatibility = {compatible: boolean; guarded: boolean};

const reject = (): SolanaTransactionCompatibility => ({compatible: false, guarded: false});
const equal = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((byte, index) => byte === b[index]);
const unsigned = (value: number, maximum: number) => Number.isInteger(value) && value >= 0 && value <= maximum;

// ABI reviewed against Jac0xb/lighthouse commit
// 4c579479c98635e419b1b167f08be02a71604a71, instruction.rs and types/assert/*.
// Borsh enum values use their ordinal wire encodings, including LogLevel.
// Only read assertions are supported. MemoryWrite, MemoryClose, Merkle CPI,
// arbitrary future instructions, and the Noop CPI logging modes are rejected.
class AssertionReader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.offset >= this.bytes.length) throw Error('Truncated assertion');
    return this.bytes[this.offset++];
  }
  skip(length: number): void {
    if (length > this.bytes.length - this.offset) throw Error('Truncated assertion');
    this.offset += length;
  }
  enumeration(maximum: number): number {
    const value = this.byte();
    if (value > maximum) throw Error('Unknown assertion value');
    return value;
  }
  compactU64(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      const byte = this.byte();
      if (index === 9 && byte > 1) throw Error('Assertion integer overflow');
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if (!(byte & 0x80)) {
        if (index > 0 && byte === 0) throw Error('Noncanonical assertion integer');
        return value;
      }
    }
    throw Error('Assertion integer overflow');
  }
  vector(parse: () => void): void {
    const count = this.compactU64();
    if (count < 1n || count > 32n) throw Error('Unsupported assertion count');
    for (let index = 0; index < Number(count); index++) parse();
  }
  optionPublicKey(): void {
    if (this.enumeration(1)) this.skip(32);
  }
  done(): boolean {return this.offset === this.bytes.length;}
}

function accountInfoAssertion(reader: AssertionReader): void {
  const kind = reader.enumeration(8);
  if (kind === 0 || kind === 1 || kind === 4) {
    // Lamports, data length, rent epoch: u64 + integer operator.
    reader.skip(8); reader.enumeration(7);
  } else if (kind === 2) {
    reader.skip(32); reader.enumeration(1); // Owner public key + equality.
  } else if (kind === 3) {
    reader.enumeration(8); reader.enumeration(1); // KnownProgram + equality.
  } else if (kind >= 5 && kind <= 7) {
    reader.enumeration(1); reader.enumeration(1); // Signer/writable/executable bool.
  } else {
    reader.skip(32); // Expected data hash, compact start, compact length.
    const start = reader.compactU64(), length = reader.compactU64();
    if (start + length > 0xffffffffffffffffn) throw Error('Assertion range overflow');
  }
}

function loaderAssertion(reader: AssertionReader): void {
  const kind = reader.enumeration(3);
  if (kind === 0) {
    reader.enumeration(3); reader.enumeration(1); // Loader state + equality.
  } else if (kind === 1) {
    reader.enumeration(0); reader.optionPublicKey(); reader.enumeration(1); // Buffer authority.
  } else if (kind === 2) {
    reader.enumeration(0); reader.skip(32); reader.enumeration(1); // ProgramData address.
  } else if (reader.enumeration(1) === 0) {
    reader.optionPublicKey(); reader.enumeration(1); // ProgramData upgrade authority.
  } else {
    reader.skip(8); reader.enumeration(7); // ProgramData slot.
  }
}

function readAssertion(instruction: MessageCompiledInstruction, message: VersionedMessage, originalAccounts: Set<string>): boolean {
  const reader = new AssertionReader(instruction.data);
  const opcode = reader.byte(), logMode = reader.byte();
  if (![0, 1, 2, 4, 5].includes(logMode)) return false;
  if (opcode === 15) {
    if (instruction.accountKeyIndexes.length !== 0) return false;
    reader.enumeration(4); reader.skip(8); reader.enumeration(7); // Clock field, i64/u64, operator.
  } else {
    if (instruction.accountKeyIndexes.length !== 1) return false;
    const target = message.staticAccountKeys[instruction.accountKeyIndexes[0]];
    if (!target || !originalAccounts.has(target.toBase58())) return false;
    if (opcode === 5) accountInfoAssertion(reader);
    else if (opcode === 6) reader.vector(() => accountInfoAssertion(reader));
    else if (opcode === 13) loaderAssertion(reader);
    else if (opcode === 14) reader.vector(() => loaderAssertion(reader));
    else return false;
  }
  return reader.done();
}

function validMessage(message: VersionedMessage): boolean {
  if ((message.version !== 0 && message.version !== 'legacy') || message.addressTableLookups.length !== 0) return false;
  const keys = message.staticAccountKeys, header = message.header;
  if (keys.length < 1 || keys.length > 256 || header.numRequiredSignatures !== 1 || header.numReadonlySignedAccounts !== 0 || !unsigned(header.numReadonlyUnsignedAccounts, keys.length - 1)) return false;
  if (new Set(keys.map(key => key.toBase58())).size !== keys.length) return false;
  return message.compiledInstructions.every(instruction => unsigned(instruction.programIdIndex, keys.length - 1) && instruction.accountKeyIndexes.every(index => unsigned(index, keys.length - 1)));
}

function sameAccount(expected: VersionedMessage, expectedIndex: number, actual: VersionedMessage, actualIndex: number): boolean {
  return expected.staticAccountKeys[expectedIndex].equals(actual.staticAccountKeys[actualIndex]) && expected.isAccountSigner(expectedIndex) === actual.isAccountSigner(actualIndex) && expected.isAccountWritable(expectedIndex) === actual.isAccountWritable(actualIndex);
}

function sameInstruction(expected: VersionedMessage, before: MessageCompiledInstruction, actual: VersionedMessage, after: MessageCompiledInstruction): boolean {
  return sameAccount(expected, before.programIdIndex, actual, after.programIdIndex) && equal(before.data, after.data) && before.accountKeyIndexes.length === after.accountKeyIndexes.length && before.accountKeyIndexes.every((index, position) => sameAccount(expected, index, actual, after.accountKeyIndexes[position]));
}

/**
 * Accept a same-version legacy/v0 message or narrowly recognized Phantom
 * Lighthouse read assertions around that exact operation. This trusts the published Lighthouse
 * program at the address above for the reviewed read-only opcode semantics;
 * this is not an allowlist for every operation that program can perform.
 *
 * Comparison resolves account indexes because adding the readonly guard program
 * can reorder static keys. Existing accounts retain exactly their privileges.
 * Nothing is removed from or changed in the actual message. Callers must verify
 * signatures over that actual message, enforce packet/fee limits, simulate and
 * persist the complete signed packet before broadcasting it.
 */
export function validateSolanaTransactionCompatibility(expectedBytes: Uint8Array, returnedMessage: VersionedMessage): SolanaTransactionCompatibility {
  try {
    const expected = VersionedMessage.deserialize(Uint8Array.from(expectedBytes));
    const actual = returnedMessage;
    if (!validMessage(expected) || !validMessage(actual) || expected.version !== actual.version) return reject();
    // The prepared input must also be a complete canonical message.
    if (!equal(expected.serialize(), expectedBytes)) return reject();
    if (equal(expectedBytes, actual.serialize())) return {compatible: true, guarded: false};
    if (expected.recentBlockhash !== actual.recentBlockhash || !expected.staticAccountKeys[0].equals(actual.staticAccountKeys[0])) return reject();

    const expectedKeys = expected.staticAccountKeys.map(key => key.toBase58());
    const originalAccounts = new Set(expectedKeys);
    if (originalAccounts.has(LIGHTHOUSE_PROGRAM_ADDRESS) || actual.staticAccountKeys.length !== expectedKeys.length + 1) return reject();
    const actualKeys = actual.staticAccountKeys.map(key => key.toBase58());
    const guardIndex = actualKeys.indexOf(LIGHTHOUSE_PROGRAM_ADDRESS);
    if (guardIndex < 0 || actual.isAccountSigner(guardIndex) || actual.isAccountWritable(guardIndex)) return reject();
    for (let index = 0; index < expectedKeys.length; index++) {
      const actualIndex = actualKeys.indexOf(expectedKeys[index]);
      if (actualIndex < 0 || !sameAccount(expected, index, actual, actualIndex)) return reject();
    }

    let expectedIndex = 0, guardCount = 0;
    for (const instruction of actual.compiledInstructions) {
      if (instruction.programIdIndex === guardIndex) {
        if (++guardCount > 8 || !readAssertion(instruction, actual, originalAccounts)) return reject();
      } else {
        const before = expected.compiledInstructions[expectedIndex++];
        if (!before || !sameInstruction(expected, before, actual, instruction)) return reject();
      }
    }
    return guardCount > 0 && expectedIndex === expected.compiledInstructions.length ? {compatible: true, guarded: true} : reject();
  } catch {
    return reject();
  }
}
