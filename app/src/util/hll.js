// HyperLogLog: the number of distinct values in a set, estimated from a fixed
// 4 KB of registers (about 1.6% standard error), and sketches of two sets
// merge into the sketch of their union. Unique clients are counted this way:
// a busy hour can hold millions of one-time IPv6 addresses, far too many to
// keep, and an exact count per hour cannot be added across hours.
//
// Stored compactly (encode): a set of a few values as the registers it sets,
// otherwise all of them.

const P = 12;
const M = 1 << P; // registers
const ALPHA = 0.7213 / (1 + 1.079 / M);
const DENSE = 0;
const SPARSE = 1;

/** 32-bit MurmurHash3 of a string's UTF-16 code units. */
function hash(s) {
  let h = 0x9747b28c;
  const n = s.length;
  let i = 0;
  for (; i + 1 < n; i += 2) {
    let k = (s.charCodeAt(i) & 0xffff) | ((s.charCodeAt(i + 1) & 0xffff) << 16);
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  if (i < n) {
    let k = s.charCodeAt(i) & 0xffff;
    k = Math.imul(k, 0xcc9e2d51);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, 0x1b873593);
    h ^= k;
  }
  h ^= n;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export function newSketch() {
  return new Uint8Array(M);
}

/**
 * Where a value (a string) lands in a sketch, as idx * 256 + rank — worked
 * out once for a value added to several sketches (addPlace).
 */
export function placeOf(value) {
  const h = hash(value);
  const rest = (h << P) >>> 0;
  // Position of the first set bit in the remaining 20 bits, from 1.
  const rank = rest === 0 ? 32 - P + 1 : Math.clz32(rest) + 1;
  return (h >>> (32 - P)) * 256 + rank;
}

export function addPlace(regs, place) {
  const idx = place >>> 8;
  const rank = place & 0xff;
  if (rank > regs[idx]) regs[idx] = rank;
}

/** Add a value (a string) to a sketch. */
export function addTo(regs, value) {
  addPlace(regs, placeOf(value));
}

/** Fold `from` into `into`: the sketch of both sets. */
export function mergeInto(into, from) {
  for (let i = 0; i < M; i++) if (from[i] > into[i]) into[i] = from[i];
}

/** Estimated number of distinct values added. */
export function estimate(regs) {
  let sum = 0;
  let zeros = 0;
  for (let i = 0; i < M; i++) {
    sum += 2 ** -regs[i];
    if (regs[i] === 0) zeros += 1;
  }
  const raw = (ALPHA * M * M) / sum;
  // Few values: count the empty registers instead, which is near exact.
  if (raw <= 2.5 * M && zeros) return Math.round(M * Math.log(M / zeros));
  return Math.round(raw);
}

/** A sketch as stored: its set registers when few are, otherwise all. */
export function encode(regs) {
  let used = 0;
  for (let i = 0; i < M; i++) if (regs[i]) used += 1;
  if (used * 3 + 1 >= M + 1) {
    const out = Buffer.alloc(M + 1);
    out[0] = DENSE;
    out.set(regs, 1);
    return out;
  }
  const out = Buffer.alloc(1 + used * 3);
  out[0] = SPARSE;
  let o = 1;
  for (let i = 0; i < M; i++) {
    if (!regs[i]) continue;
    out.writeUInt16BE(i, o);
    out[o + 2] = regs[i];
    o += 3;
  }
  return out;
}

/** Merge a stored sketch (encode) into `into`. Ignores anything unreadable. */
export function mergeEncoded(into, buf) {
  if (!buf?.length) return;
  if (buf[0] === DENSE && buf.length === M + 1) {
    for (let i = 0; i < M; i++) if (buf[i + 1] > into[i]) into[i] = buf[i + 1];
  } else if (buf[0] === SPARSE && (buf.length - 1) % 3 === 0) {
    for (let o = 1; o < buf.length; o += 3) {
      const i = buf.readUInt16BE(o);
      if (i < M && buf[o + 2] > into[i]) into[i] = buf[o + 2];
    }
  }
}
