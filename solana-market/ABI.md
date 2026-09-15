# Slot Market binary interface, version 1

This is the native SOL marketplace program. A token mint address is separate
from this program's address. No mint or token account is needed to buy a slot.

The immutable dev, treasury, and admin address is
`8Rxj2R1c3kUGcdKYyLEXkzYvARxrrvFFtSEwhBPz1WN9`.
The 62 advertising space IDs form the complete buyable catalog. Official coin information
and the official X link have **no slot ID** and cannot be purchased.

## Program and PDA addresses

The deployment program ID is supplied by Solana's runtime. It is not embedded
in this source and must be verified/configured separately before enabling the
website. Each slot uses the canonical program-derived address (PDA):

```
findProgramAddress([UTF8("slot"), u16LittleEndian(slotId)], programId)
```

Only IDs 0 through 61 are accepted. There is no initializer or mutable market
configuration account. The canonical treasury and 62 initial prices are compiled
into the program. `build.rs` reads the shared `lib/slots.json` dimensions. For
an area `a`, minimum area 1,600 and maximum area 264,000, the initial lamports are:

```
100_000_000 + floor(((a - 1_600) * 1_900_000_000 + 131_200_000_000)
                   / 262_400_000_000) * 1_000_000
```

This is 0.1–2 SOL, scaled by area and rounded half-up to 0.001 SOL.
It does not convert the legacy Ethereum price or any legacy ownership.

## Slot account layout

All unsigned integers use little-endian encoding; addresses use their raw 32
bytes, not base58 text. The account is exactly **857 bytes** and is owned by the
configured program. Strings are UTF-8, lengths count bytes, and unused string
space must contain zeros.

| Offset | Bytes | Field |
| --- | --- | --- |
| 0 | 8 | ASCII discriminator `SLOTMKT1` |
| 8 | 2 | Slot ID, u16 |
| 10 | 32 | Current owner; all zeros means unclaimed |
| 42 | 8 | Last paid lamports, u64 |
| 50 | 8 | Mutation version, u64 |
| 58 | 1 | Moderation lock, exactly 0 or 1 |
| 59 | 2 | Text byte length, u16, maximum 280 |
| 61 | 280 | Text bytes followed by zero padding |
| 341 | 2 | Image URL byte length, u16, maximum 256 |
| 343 | 256 | Image URL bytes followed by zero padding |
| 599 | 2 | Link URL byte length, u16, maximum 256 |
| 601 | 256 | Link URL bytes followed by zero padding |

A missing PDA, or a System Program-owned PDA with empty data, is unclaimed with
owner zero, paid 0, version 0, unlocked, and empty content. A program-owned slot
must have a valid discriminator, ID, canonical padding, and version at least 1.
Owner zero must coincide with paid 0. Admin moderation can create an unclaimed
slot with version 1 or higher, so ownership must not be inferred from existence.

## Accounts for every instruction

Provide exactly these four account metas in order:

| Index | Account | Signer | Writable |
| --- | --- | --- | --- |
| 0 | Actor wallet (buyer, owner, or admin) | Yes | Yes |
| 1 | Canonical slot PDA | No | Yes |
| 2 | Immutable treasury above | No | Yes |
| 3 | System Program `11111111111111111111111111111111` | No | No |

Actor must be a nonexecutable, System Program-owned account with empty data.
Treasury and actor can be the same wallet; actor/treasury cannot alias the slot.
The client should use the actor as fee payer. Owners and the admin still pay
network transaction fees. The first actor to create a slot also funds its rent
reserve. A prefunded System-owned PDA is allocated/assigned with a rent top-up,
so somebody sending SOL to a slot PDA cannot block its first purchase.

## Instruction layout

Each instruction ends with three dynamic strings in this order: text, image
URL, link URL. Each string is encoded as `u16 byteLength` immediately followed
by that many UTF-8 bytes, with no padding in instruction data. No trailing bytes
are permitted. All strings replace the respective current fields; an empty
string clears that field. Instructions and state share the byte-length limits.

### Buy, opcode 0

```
u8(0), u16(slotId), bytes32(expectedOwner), u64(expectedPaid),
u64(expectedVersion), u64(exactPayment), strings
```

The fixed header before strings is 59 bytes. The program compares all three
expected fields against current state before changing anything. Price is the
compiled initial price for an unclaimed slot, otherwise twice its last paid
price. `exactPayment` must equal that price; underpayment and overpayment fail.
All payment goes directly to the treasury. The previous owner receives nothing.
The first purchase additionally funds any missing account rent reserve.

Successful purchase replaces the owner, price, and content, clears any moderation
lock, and increments version. A locked current owner cannot self-purchase to
bypass moderation; a different buyer can take over at the normal doubled price.
An unlocked owner may self-purchase. A treasury purchase has no net SOL transfer
to itself but still requires the full quoted balance after rent and fees.

### Owner edit, opcode 1

```
u8(1), u16(slotId), u64(expectedVersion), strings
```

The fixed header is 11 bytes. Only the current owner can edit an unlocked slot.
The quote version must still match. Editing preserves owner, last price, and
lock, replaces content, and increments version. There is no slot fee.

### Admin moderation, opcode 2

```
u8(2), u16(slotId), u64(expectedVersion), u8(locked), strings
```

The fixed header is 12 bytes. Only the immutable treasury/admin can moderate.
The version must still match. Moderation preserves owner and last price, updates
content and lock, and increments version. Blank strings remove content. An
unclaimed slot may be initialized this way, with the admin funding its rent.
Moderation has no slot fee.

## Content validation

Text accepts valid UTF-8 and rejects control characters except newline and tab.
Image/link are empty or ASCII absolute `https://` URLs. They cannot contain
credentials, whitespace, controls, backslashes, quotes, angle brackets, or
backticks. Hosts use DNS/IPv4 label syntax, optionally with a port 1–65535.
IPv6 literal URLs and raw Unicode hostnames/paths are not accepted; encode them
to an ASCII URL before submitting. Percent escapes must use two hex digits.
These checks do not endorse or fetch any advertised destination. The frontend
must escape text, use safe external-link attributes, and apply its image policy.

## Custom error codes

| Code | Meaning |
| --- | --- |
| 6000 | Malformed or unknown instruction |
| 6001 | Slot ID outside 0–61 |
| 6002 | Wrong PDA, account count, mutability, actor account, or alias |
| 6003 | Actor signature missing |
| 6004 | Treasury substituted |
| 6005 | Wrong account owner or malformed/corrupt slot state |
| 6006 | Stale owner, last price, or version |
| 6007 | Payment differs from exact current quote |
| 6008 | Actor is not current owner |
| 6009 | Current owner is blocked by moderation lock |
| 6010 | Actor is not immutable admin |
| 6011 | Price or version overflow |
| 6012 | Invalid/oversized content |
| 6013 | Insufficient balance for rent or full price |
| 6014 | System Program substituted or not executable |

System Program and Solana runtime errors may also occur. All checks happen
before CPIs where possible. A failure after rent funding/allocation still rolls
back every program state/payment change atomically; transaction fees may remain.
