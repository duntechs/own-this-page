import {type VersionedTransaction} from '@solana/web3.js';
import {LIGHTHOUSE_PROGRAM_ADDRESS} from './solana-transaction-compatibility';

const SYSTEM = '11111111111111111111111111111111';
const LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

class Reader {
  private offset = 0;
  constructor(private readonly data: Uint8Array) {}
  byte() {if (this.offset >= this.data.length) throw Error('Truncated assertion'); return this.data[this.offset++];}
  bytes(length: number) {if (this.offset + length > this.data.length) throw Error('Truncated assertion'); const result = this.data.subarray(this.offset, this.offset + length); this.offset += length; return result;}
  u64() {const bytes = this.bytes(8); let value = 0n; for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[index]); return value;}
  done() {return this.offset === this.data.length;}
}

/**
 * Additional gate for grouping loader Writes after normal message/signature
 * validation. Writes leave account ownership, length and buffer authority
 * unchanged; the only lamport change is the payer's exact transaction fee.
 * Accept only those invariant assertions and payer lower bounds satisfied even
 * after EVERY fee in the group. Unknown guards, hashes and clock checks require
 * individual approvals. Nothing is removed from or changed in a signed packet.
 * Wire enums match the pinned Lighthouse ABI in solana-transaction-compatibility.
 */
export function deploymentUploadBatchIsSafe(transactions: readonly VersionedTransaction[], options: {
  owner: string; buffer: string; balanceLamports: number; totalFeeLamports: number;
}): boolean {
  try {
    if (!transactions.length || transactions.length > 5 ||
        !Number.isSafeInteger(options.balanceLamports) || !Number.isSafeInteger(options.totalFeeLamports) ||
        options.totalFeeLamports <= 0 || options.balanceLamports < options.totalFeeLamports) return false;
    const minimumBalance = BigInt(options.balanceLamports - options.totalFeeLamports);
    for (const transaction of transactions) {
      const message = transaction.message;
      if (message.version !== 0 || message.addressTableLookups.length || message.staticAccountKeys[0]?.toBase58() !== options.owner || message.header.numRequiredSignatures !== 1) return false;
      const owner = message.staticAccountKeys[0];
      const bufferIndex = message.staticAccountKeys.findIndex(key => key.toBase58() === options.buffer);
      const loaderIndex = message.staticAccountKeys.findIndex(key => key.toBase58() === LOADER);
      if (bufferIndex < 0 || loaderIndex < 0) return false;
      let writeCount = 0, computeCount = 0;
      for (const instruction of message.compiledInstructions) {
        const program = message.staticAccountKeys[instruction.programIdIndex]?.toBase58();
        if (program === COMPUTE) {if (++computeCount > 2) return false; continue;}
        if (program === LOADER) {
          const data = instruction.data;
          if (++writeCount !== 1 || data.length <= 16 || data.length > 716 ||
              data[0] !== 1 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0 ||
              instruction.accountKeyIndexes.length !== 2 || instruction.accountKeyIndexes[0] !== bufferIndex || instruction.accountKeyIndexes[1] !== 0) return false;
          continue;
        }
        if (program !== LIGHTHOUSE_PROGRAM_ADDRESS || instruction.accountKeyIndexes.length !== 1) return false;
        const target = instruction.accountKeyIndexes[0];
        if (target !== 0 && target !== bufferIndex) return false;
        const reader = new Reader(instruction.data), opcode = reader.byte(), logMode = reader.byte();
        if (![0, 1, 2, 4, 5].includes(logMode)) return false;
        const accountAssertion = (): boolean => {
          const kind = reader.byte();
          if (target === 0 && kind === 0) {const floor = reader.u64(); return reader.byte() === 4 && floor <= minimumBalance;}
          if (target === 0 && kind === 1) return reader.u64() === 0n && reader.byte() === 0;
          if (kind === 2) {
            const expected = reader.bytes(32);
            const correctOwner = target === 0 ? new Uint8Array(32) : message.staticAccountKeys[loaderIndex].toBytes();
            return equal(expected, correctOwner) && reader.byte() === 0;
          }
          // KnownProgram::System and equality, on the fee payer only.
          if (target === 0 && kind === 3) return reader.byte() === 0 && reader.byte() === 0;
          return false;
        };
        if (opcode === 5) {if (!accountAssertion()) return false;}
        else if (opcode === 6) {
          // Canonical compact length for this deliberately small assertion set.
          const count = reader.byte(); if (count < 1 || count > 8) return false;
          for (let index = 0; index < count; index++) if (!accountAssertion()) return false;
        } else if (opcode === 13 && target === bufferIndex) {
          // Buffer authority == the connected owner, with Some(public key).
          if (reader.byte() !== 1 || reader.byte() !== 0 || reader.byte() !== 1 || !equal(reader.bytes(32), owner.toBytes()) || reader.byte() !== 0) return false;
        } else return false;
        if (!reader.done()) return false;
      }
      if (writeCount !== 1 || computeCount !== 2) return false;
      // Reject an unrelated system transfer even if a caller bypassed the
      // primary comparison. System is only an expected owner inside a guard.
      if (message.compiledInstructions.some(instruction => message.staticAccountKeys[instruction.programIdIndex]?.toBase58() === SYSTEM)) return false;
    }
    return true;
  } catch {return false;}
}
