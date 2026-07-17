/**
 * Stellar strkey encoding — turns an ed25519 keypair into the familiar `G…` address and `S…` secret.
 *
 * strkey = base32( versionByte(1) ‖ payload(32) ‖ crc16-xmodem(2, little-endian) ), no padding.
 * Implemented from the spec (SEP-0023) with pure-JS deps so there's no native crypto to polyfill.
 * Verified byte-for-byte against @stellar/stellar-base test vectors (see Docs/account-recovery.md).
 */
import { base32 } from '@scure/base';

// Version bytes (high 5 bits select the type): public key 'G', secret seed 'S'.
const VERSION_ED25519_PUBLIC_KEY = 6 << 3; // 48 → 'G'
const VERSION_ED25519_SECRET_SEED = 18 << 3; // 144 → 'S'

/** CRC16-XMODEM (poly 0x1021, init 0x0000) over the version byte + payload. */
function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

function encodeCheck(versionByte: number, payload: Uint8Array): string {
  const data = new Uint8Array(1 + payload.length);
  data[0] = versionByte;
  data.set(payload, 1);
  const crc = crc16xmodem(data);
  const full = new Uint8Array(data.length + 2);
  full.set(data, 0);
  full[data.length] = crc & 0xff; // checksum is little-endian
  full[data.length + 1] = (crc >> 8) & 0xff;
  return base32.encode(full).replace(/=+$/, ''); // Stellar strkeys carry no padding
}

/** Encode a 32-byte ed25519 public key as a Stellar `G…` address. */
export function encodeStellarPublicKey(publicKey: Uint8Array): string {
  return encodeCheck(VERSION_ED25519_PUBLIC_KEY, publicKey);
}

/** Encode a 32-byte ed25519 seed as a Stellar `S…` secret. */
export function encodeStellarSecretSeed(seed: Uint8Array): string {
  return encodeCheck(VERSION_ED25519_SECRET_SEED, seed);
}
