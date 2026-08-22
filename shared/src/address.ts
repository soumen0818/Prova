/**
 * The Prova receive address: the value one wallet shares so another can pay it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FORMAT
 * ---------------------------------------------------------------------------
 * An address carries 96 bytes of key material — `ownerPk`, and the `x`/`y` of the note-encryption
 * key. The first format spent 302 characters saying it: hex-encoded the bytes (2x), wrapped them in
 * JSON keys and quotes (+30), then base64'd the whole thing (x1.33). Only a third of it was signal.
 *
 * This encodes the bytes directly and adds a checksum:
 *
 *     prova-pay:<base64url( version(1) | ownerPk(32) | encPkX(32) | encPkY(32) | crc32(4) )>
 *
 * 145 characters, and — more importantly — a corrupted one is *rejected* rather than accepted.
 * That matters more than the length. With raw bytes and no checksum, any 96-byte blob decodes to a
 * perfectly well-formed address, so a truncated paste or a mis-scanned QR would silently become a
 * different, unowned destination and the money would be unrecoverable. The old JSON format got that
 * safety by accident, because damaged input usually failed to parse. Here it is deliberate.
 *
 * CRC-32 is not cryptographic and does not need to be: an address is public, and the threat is a
 * transmission error, not forgery. Stellar's own addresses use CRC-16 for exactly this. Four bytes
 * makes an undetected corruption a ~1-in-4-billion event.
 *
 * ---------------------------------------------------------------------------
 * COMPATIBILITY
 * ---------------------------------------------------------------------------
 * `decodePoolAddress` still reads the legacy JSON form, so recipients saved before this change keep
 * working. Only new addresses are written in the short form. The two are told apart by their first
 * byte — 0x01 for this format, `{` (0x7B) for the legacy JSON — which cannot collide.
 *
 * No dependencies, on purpose: this package is consumed by the app (Hermes), the backend tooling and
 * the web app, and base64 is not reliably available in all three.
 */

/** Scheme prefix, kept so a pasted address is recognisable as one. */
export const POOL_ADDRESS_SCHEME = 'prova-pay:';

/** Format marker. Lets a future change be detected rather than misread. */
const ADDRESS_VERSION = 0x01;

const KEY_BYTES = 32;
const CHECKSUM_BYTES = 4;
const PAYLOAD_BYTES = 1 + KEY_BYTES * 3 + CHECKSUM_BYTES; // 101

/** The three public values that make up an address. Hex, as the rest of the pool code uses. */
export interface PoolAddress {
  ownerPk: string;
  encPkX: string;
  encPkY: string;
}

// ---------------------------------------------------------------------------
// Primitives — written out rather than imported, see the note above about deps.
// ---------------------------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding: URL-safe, QR-friendly, and no `=` to be lost in a copy-paste. */
function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_ALPHABET[(triple >> 18) & 63];
    out += B64_ALPHABET[(triple >> 12) & 63];
    if (i + 1 < bytes.length) out += B64_ALPHABET[(triple >> 6) & 63];
    if (i + 2 < bytes.length) out += B64_ALPHABET[triple & 63];
  }
  return out;
}

function base64UrlDecode(text: string): Uint8Array | null {
  const clean = text.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64_ALPHABET.indexOf(ch);
    if (v < 0) return null; // rejects the standard alphabet's + and /, and any stray character
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** CRC-32 (IEEE), computed without a lookup table — 101 bytes is far too little to optimise for. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      // The conditional is on the low bit, so this is the reflected form of the polynomial.
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

// ---------------------------------------------------------------------------
// Encode / decode
// ---------------------------------------------------------------------------

/**
 * Serialise an address for a QR code or a copy-paste.
 *
 * Throws on a malformed input rather than producing an address that cannot be paid: this is called
 * with the wallet's own keys, so a bad value here is a programming error, not user input.
 */
export function encodePoolAddress(addr: PoolAddress): string {
  const parts = [addr.ownerPk, addr.encPkX, addr.encPkY].map(hexToBytes);
  if (parts.some((p) => p === null || p.length !== KEY_BYTES)) {
    throw new Error('pool address: each key must be 32 bytes of hex');
  }

  const body = new Uint8Array(1 + KEY_BYTES * 3);
  body[0] = ADDRESS_VERSION;
  parts.forEach((p, i) => body.set(p as Uint8Array, 1 + i * KEY_BYTES));

  const sum = crc32(body);
  const payload = new Uint8Array(PAYLOAD_BYTES);
  payload.set(body, 0);
  payload[body.length] = (sum >>> 24) & 0xff;
  payload[body.length + 1] = (sum >>> 16) & 0xff;
  payload[body.length + 2] = (sum >>> 8) & 0xff;
  payload[body.length + 3] = sum & 0xff;

  return POOL_ADDRESS_SCHEME + base64UrlEncode(payload);
}

/**
 * Parse an address. Returns `null` for anything that is not a valid, intact one.
 *
 * Never throws and never guesses: for a value that decides where money goes, "I could not read this"
 * has to be the answer for every input that is not exactly right.
 */
export function decodePoolAddress(text: string): PoolAddress | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(POOL_ADDRESS_SCHEME)) return null;
  const body = trimmed.slice(POOL_ADDRESS_SCHEME.length);

  const bytes = base64UrlDecode(body);
  if (bytes && bytes.length === PAYLOAD_BYTES && bytes[0] === ADDRESS_VERSION) {
    const signed = bytes.subarray(0, 1 + KEY_BYTES * 3);
    const expected = crc32(signed);
    const actual =
      ((bytes[PAYLOAD_BYTES - 4]! << 24) |
        (bytes[PAYLOAD_BYTES - 3]! << 16) |
        (bytes[PAYLOAD_BYTES - 2]! << 8) |
        bytes[PAYLOAD_BYTES - 1]!) >>>
      0;
    // A damaged address must be refused, not paid.
    if (expected !== actual) return null;
    return {
      ownerPk: bytesToHex(signed.subarray(1, 1 + KEY_BYTES)),
      encPkX: bytesToHex(signed.subarray(1 + KEY_BYTES, 1 + KEY_BYTES * 2)),
      encPkY: bytesToHex(signed.subarray(1 + KEY_BYTES * 2)),
    };
  }

  return decodeLegacyPoolAddress(body);
}

/**
 * The original format: base64 of `{"pk":"…","ex":"…","ey":"…"}` in hex.
 *
 * Kept so addresses already saved as recipients, or sitting in a chat thread, still resolve. New
 * addresses are never written in this form.
 */
function decodeLegacyPoolAddress(body: string): PoolAddress | null {
  // The legacy encoder used standard base64, whose + and / are not in the url-safe alphabet.
  const normalised = body.replace(/\+/g, '-').replace(/\//g, '_');
  const bytes = base64UrlDecode(normalised);
  if (!bytes || bytes.length === 0 || bytes[0] !== 0x7b /* '{' */) return null;

  let json = '';
  for (const b of bytes) json += String.fromCharCode(b);

  try {
    const parsed = JSON.parse(json) as { pk?: unknown; ex?: unknown; ey?: unknown };
    const { pk, ex, ey } = parsed;
    if (typeof pk !== 'string' || typeof ex !== 'string' || typeof ey !== 'string') return null;
    // Same shape check the new format gets for free from its fixed length.
    for (const v of [pk, ex, ey]) {
      const raw = hexToBytes(v);
      if (!raw || raw.length !== KEY_BYTES) return null;
    }
    return { ownerPk: pk, encPkX: ex, encPkY: ey };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Share links
// ---------------------------------------------------------------------------

/** Where a pay link points. Must match the host claimed in the app's Android intent filters. */
export const PAY_LINK_ORIGIN = 'https://provapay.duckdns.org';

/**
 * A tappable link that adds this wallet as a recipient.
 *
 * The address rides in the URL **fragment**, and that is the whole point: a fragment is never sent
 * to the server. On a phone with Prova installed Android hands the URI straight to the app and no
 * request happens at all; without it, the browser opens the page and the address still stays on the
 * device. Either way the server never learns who is paying whom — which is what makes this a
 * replacement for a lookup directory rather than a step toward one.
 *
 * A query parameter would look identical to a user and would leak the address into server logs,
 * proxies and referrer headers.
 */
export function encodePayLink(addr: PoolAddress): string {
  return `${PAY_LINK_ORIGIN}/pay#${encodePoolAddress(addr)}`;
}

/**
 * Read an address out of a pay link, or out of a bare address.
 *
 * Accepts both because a scanner or a paste box cannot know which it is being given: a QR code holds
 * a bare address, a shared link holds a URL, and users will paste either into either. Deciding here
 * means every entry point behaves the same.
 */
export function decodePayLink(input: string): PoolAddress | null {
  const text = input.trim();
  const hash = text.indexOf('#');
  if (hash !== -1) {
    const direct = decodePoolAddress(text.slice(hash + 1));
    if (direct) return direct;
  }
  return decodePoolAddress(text);
}
