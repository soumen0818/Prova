/**
 * Validation parity tests.
 *
 * These cases are mirrored EXACTLY in `shared/go/schema/validation_test.go`. That is the entire
 * point of putting the rules in `shared`: the app and the API cannot drift apart, and if they ever
 * do it should surface here rather than as a user who can sign up on one path but not the other.
 *
 * Run with `npm test` (Node's built-in runner — no extra dependency).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COUNTRIES,
  DEFAULT_COUNTRY,
  EMAIL_LOCAL_MAX,
  NAME_MAX,
  PHONE_DIGITS_MAX,
  findCountry,
  isSupportedE164,
  isValidE164,
  isValidEmail,
  isValidName,
  isValidNationalNumber,
  isValidOtp,
  normalizeEmail,
  normalizeName,
  toE164,
} from './validation.js';

test('isValidEmail accepts real addresses', () => {
  for (const e of [
    'user@example.com',
    'first.last@example.co.uk',
    'user+tag@gmail.com',
    'u@ex.io',
    'UPPER@EXAMPLE.COM',
    'a_b-c@sub.domain.org',
  ]) {
    assert.equal(isValidEmail(e), true, `${e} should be valid`);
  }
});

test('isValidEmail rejects malformed addresses', () => {
  for (const e of [
    '',
    '  ',
    'plainaddress',
    '@example.com',
    'user@',
    'user@example',
    'user@example.c',
    'user@.com',
    'user@example..com',
    '.user@example.com',
    'user.@example.com',
    'us..er@example.com',
    'user@-example.com',
    'user@example.com-',
    'user name@example.com',
    'user@exam ple.com',
    'user@example.123',
  ]) {
    assert.equal(isValidEmail(e), false, `${e} should be rejected`);
  }
  assert.equal(isValidEmail('a'.repeat(EMAIL_LOCAL_MAX + 1) + '@example.com'), false);
});

test('normalizeEmail trims and lowercases', () => {
  assert.equal(normalizeEmail('  User@Example.COM '), 'user@example.com');
});

test('isValidOtp requires exactly six digits', () => {
  for (const good of ['000000', '123456', ' 123456 ']) {
    assert.equal(isValidOtp(good), true, `${good} should be valid`);
  }
  for (const bad of ['', '12345', '1234567', '12345a', 'abcdef', '12 34 56', '-12345']) {
    assert.equal(isValidOtp(bad), false, `${bad} should be rejected`);
  }
});

test('isValidName accepts real names, including Indic scripts', () => {
  // The combining-mark cases matter: a \p{L}-only rule silently rejects most Indic names, which
  // would lock out a large share of this corridor.
  for (const n of ['Ravi Kumar', "O'Brien", 'Jean-Luc', 'R. Kumar', 'Ali', 'সৌমেন', '李伟', 'José']) {
    assert.equal(isValidName(n), true, `${n} should be valid`);
  }
});

test('isValidName rejects junk', () => {
  for (const n of ['', ' ', 'A', 'Ravi123', 'Ravi@Home', "'Ravi", '-Ravi', '.Ravi']) {
    assert.equal(isValidName(n), false, `${n} should be rejected`);
  }
  assert.equal(isValidName('a'.repeat(NAME_MAX + 1)), false);
});

test('normalizeName collapses whitespace', () => {
  assert.equal(normalizeName('  Ravi   Kumar  '), 'Ravi Kumar');
});

test('isValidNationalNumber uses each country own length', () => {
  // One hardcoded length would reject every valid UAE number — half the corridor.
  assert.equal(isValidNationalNumber('501234567', 'AE'), true);
  assert.equal(isValidNationalNumber('5012345678', 'AE'), false);
  assert.equal(isValidNationalNumber('9876543210', 'IN'), true);
  assert.equal(isValidNationalNumber('987654321', 'IN'), false);

  // A leading zero is a trunk prefix; keeping it yields an unreachable number.
  assert.equal(isValidNationalNumber('0987654321', 'IN'), false);
  assert.equal(isValidNationalNumber('9876543210', 'ZZ'), false);
});

test('toE164 composes and strips separators', () => {
  assert.equal(toE164('501234567', 'AE'), '+971501234567');
  assert.equal(toE164('98765 43210', 'IN'), '+919876543210');
  assert.equal(toE164('123', 'IN'), null);
});

test('isValidE164 checks the whole received number', () => {
  assert.equal(isValidE164('+971501234567'), true);
  assert.equal(isValidE164('+919876543210'), true);
  for (const bad of ['', '971501234567', '+', '+abc', '+1234567', '+1234567890123456']) {
    assert.equal(isValidE164(bad), false, `${bad} should be rejected`);
  }
});

test('isSupportedE164 is stricter than isValidE164', () => {
  assert.equal(isSupportedE164('+971501234567'), true);
  assert.equal(isSupportedE164('+919876543210'), true);
  assert.equal(isSupportedE164('+9715012345'), false, 'right country, wrong length');
  assert.equal(isSupportedE164('+35312345678'), false, 'unsupported country');
});

test('the country table is well formed', () => {
  const seen = new Set<string>();
  for (const c of COUNTRIES) {
    assert.equal(seen.has(c.code), false, `duplicate ${c.code}`);
    seen.add(c.code);
    assert.equal(c.code.length, 2, `${c.code} must be alpha-2`);
    assert.match(c.dial, /^\+\d+$/, `${c.code} dial`);
    assert.ok(c.nationalDigits >= 4 && c.nationalDigits <= 12, `${c.code} length`);
    // The composed number must fit E.164, or the country is unusable.
    assert.ok(
      c.dial.length - 1 + c.nationalDigits <= PHONE_DIGITS_MAX,
      `${c.code} exceeds E.164`,
    );
    assert.ok(c.name.length > 0 && c.flag.length > 0, `${c.code} needs a name and flag`);
  }
  assert.ok(findCountry(DEFAULT_COUNTRY), 'DEFAULT_COUNTRY must exist');
  assert.ok(findCountry('ae'), 'lookup must be case-insensitive');
});
