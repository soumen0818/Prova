import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PAY_LINK_ORIGIN,
  POOL_ADDRESS_SCHEME,
  decodePoolAddress,
  encodePayLink,
  encodePoolAddress,
  decodePayLink,
  type PoolAddress,
} from './address.js';

const SAMPLE: PoolAddress = {
  ownerPk: '6cb3d3d9f5c126270f7f3bcc3cefe41b8d7bf95f19774b846221653cf52cc1e8',
  encPkX: '1d56706f0fa4621a76f454b3bd341953e3f911f78a60525a227cf4ad81c68463',
  encPkY: '0643ecd2c61d64f9baf0d2ed5078b5d04ec764228707070ce87a763fedb79c2a',
};

/** A real address produced by the original encoder, kept verbatim as the compatibility fixture. */
const LEGACY =
  'prova-pay:eyJwayI6IjZjYjNkM2Q5ZjVjMTI2MjcwZjdmM2JjYzNjZWZlNDFiOGQ3YmY5NWYxOTc3NGI4NDYyMjE2NTNjZjUyY2MxZTgiLCJleCI6IjFkNTY3MDZmMGZhNDYyMWE3NmY0NTRiM2JkMzQxOTUzZTNmOTExZjc4YTYwNTI1YTIyN2NmNGFkODFjNjg0NjMiLCJleSI6IjA2NDNlY2QyYzYxZDY0ZjliYWYwZDJlZDUwNzhiNWQwNGVjNzY0MjI4NzA3MDcwY2U4N2E3NjNmZWRiNzljMmEifQ==';

test('round-trips exactly', () => {
  assert.deepEqual(decodePoolAddress(encodePoolAddress(SAMPLE)), SAMPLE);
});

test('is far shorter than the format it replaces', () => {
  const encoded = encodePoolAddress(SAMPLE);
  assert.equal(encoded.length, 145);
  assert.ok(
    encoded.length < LEGACY.length / 2,
    `expected less than half of ${LEGACY.length}, got ${encoded.length}`,
  );
});

test('still reads addresses saved in the legacy format', () => {
  // Recipients saved before the change must keep working — the value lives in the user's phone and
  // in whatever chat thread they were sent through, neither of which can be migrated.
  assert.deepEqual(decodePoolAddress(LEGACY), SAMPLE);
});

test('rejects a truncated address instead of decoding a different one', () => {
  // The failure this checksum exists for. Without it, a shortened paste still yields 96 well-formed
  // bytes — a valid-looking address nobody owns, and money sent there is gone.
  const encoded = encodePoolAddress(SAMPLE);
  for (const cut of [1, 2, 5, 20]) {
    assert.equal(decodePoolAddress(encoded.slice(0, -cut)), null, `truncated by ${cut}`);
  }
});

test('rejects a single flipped character', () => {
  const encoded = encodePoolAddress(SAMPLE);
  const body = encoded.slice(POOL_ADDRESS_SCHEME.length);
  let caught = 0;
  for (let i = 0; i < body.length; i++) {
    const swapped = body[i] === 'A' ? 'B' : 'A';
    const damaged = POOL_ADDRESS_SCHEME + body.slice(0, i) + swapped + body.slice(i + 1);
    if (decodePoolAddress(damaged) === null) caught++;
  }
  assert.equal(caught, body.length, 'every single-character change must be rejected');
});

test('rejects anything that is not a Prova address', () => {
  for (const bad of [
    '',
    '   ',
    'hello',
    'prova-pay:',
    'prova-pay:!!!!',
    // A Stellar account and secret: both plausible mis-pastes from a wallet app.
    'GCBA5YVACDJ6MP46JNHHTMCNJD4I2NRRVEGLBAKQRYJTFBQP5BIWXZR7',
    'SAP6DAPOSERPU2MLG34YW5NSTCLDL2GBZG6Z7URPLN4UTVAWLFQNYDID',
    // Right prefix, right length, wrong content.
    POOL_ADDRESS_SCHEME + 'A'.repeat(135),
  ]) {
    assert.equal(decodePoolAddress(bad), null, JSON.stringify(bad));
  }
});

test('tolerates the whitespace a copy-paste picks up', () => {
  const encoded = encodePoolAddress(SAMPLE);
  assert.deepEqual(decodePoolAddress(`  ${encoded}\n`), SAMPLE);
});

test('refuses to encode a malformed key rather than emitting an unpayable address', () => {
  for (const broken of [
    { ...SAMPLE, ownerPk: '' },
    { ...SAMPLE, ownerPk: 'abcd' }, // right shape, wrong length
    { ...SAMPLE, encPkX: 'z'.repeat(64) }, // right length, not hex
  ]) {
    assert.throws(() => encodePoolAddress(broken), /32 bytes of hex/);
  }
});

test('two different wallets never produce the same address', () => {
  const other: PoolAddress = { ...SAMPLE, ownerPk: SAMPLE.ownerPk.replace(/^6c/, '6d') };
  assert.notEqual(encodePoolAddress(SAMPLE), encodePoolAddress(other));
});

test('a pay link round-trips and keeps the address in the fragment', () => {
  const link = encodePayLink(SAMPLE);
  assert.ok(link.startsWith(`${PAY_LINK_ORIGIN}/pay#`), link);
  // Everything identifying must sit after the '#', which browsers never transmit.
  const beforeHash = link.slice(0, link.indexOf('#'));
  assert.equal(beforeHash, `${PAY_LINK_ORIGIN}/pay`);
  assert.deepEqual(decodePayLink(link), SAMPLE);
});

test('the same parser handles a link, a bare address, and neither', () => {
  assert.deepEqual(decodePayLink(encodePayLink(SAMPLE)), SAMPLE, 'link');
  assert.deepEqual(decodePayLink(encodePoolAddress(SAMPLE)), SAMPLE, 'bare address');
  assert.deepEqual(decodePayLink(LEGACY), SAMPLE, 'legacy address');
  assert.equal(decodePayLink('https://provapay.duckdns.org/pay#broken'), null);
  assert.equal(decodePayLink('https://example.com/pay'), null);
});
