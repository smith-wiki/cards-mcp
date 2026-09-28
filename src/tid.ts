// Card ID = Bluesky TID: 13 base32-sortable chars encoding a 64-bit integer
// (top bit 0, 53 bits microseconds since the Unix epoch, 10 bits clock id).

const ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";
export const TID_PATTERN = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;

let lastMicros = 0;

export function encodeTid(micros: number, clockId: number): string {
  let value = (BigInt(micros) << 10n) | BigInt(clockId & 0x3ff);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

/** Microseconds since the Unix epoch encoded in a TID. */
export function tidMicros(tid: string): number {
  if (!TID_PATTERN.test(tid)) throw new Error(`not a Card ID: ${tid}`);
  let value = 0n;
  for (const char of tid) value = (value << 5n) | BigInt(ALPHABET.indexOf(char));
  return Number(value >> 10n);
}

/** ISO timestamp (UTC, millisecond precision) of a TID. */
export function tidCreated(tid: string): string {
  return new Date(Math.floor(tidMicros(tid) / 1000)).toISOString();
}

/**
 * New Card ID from Date.now() plus sub-millisecond randomness and a random clock id.
 * Strictly increasing within one isolate.
 */
export function generateTid(now = Date.now()): string {
  const random = crypto.getRandomValues(new Uint16Array(2));
  let micros = now * 1000 + (random[0] % 1000);
  if (micros <= lastMicros) micros = lastMicros + 1;
  lastMicros = micros;
  return encodeTid(micros, random[1] & 0x3ff);
}
