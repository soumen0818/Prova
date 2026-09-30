// Create the Jubjub key used to sign private compliance credentials.
// The secret is written directly to the gitignored .env file and is never printed.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ecMulGenerator } from '@midnight-ntwrk/compact-runtime';

const JUBJUB_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const ENV_KEY = 'CREDENTIAL_ISSUER_SECRET';

const fail = (message) => {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
};

const readConfiguredSecret = (contents) => {
  const match = contents.match(/^CREDENTIAL_ISSUER_SECRET=(.*)$/m);
  return match?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
};

const scalarFromHex = (secretHex) => BigInt(`0x${secretHex}`) % JUBJUB_ORDER;

const validate = (secretHex) => {
  if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
    fail(`${ENV_KEY} must contain exactly 64 hexadecimal characters.`);
  }
  const scalar = scalarFromHex(secretHex);
  if (scalar === 0n) fail(`${ENV_KEY} reduces to the invalid zero scalar.`);
  return scalar;
};

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const existing = readConfiguredSecret(env);
const show = process.argv.includes('--show');

let secretHex;
if (show) {
  if (!existing) fail(`${ENV_KEY} is not configured; run npm run issuer:new first.`);
  secretHex = existing;
} else {
  if (existing) {
    fail(
      `${ENV_KEY} is already configured. Refusing to rotate it implicitly; ` +
        'use the on-chain rotation flow deliberately.',
    );
  }

  do {
    secretHex = randomBytes(32).toString('hex');
  } while (scalarFromHex(secretHex) === 0n);

  const assignment = `${ENV_KEY}="${secretHex}"`;
  const updated = /^CREDENTIAL_ISSUER_SECRET=.*$/m.test(env)
    ? env.replace(/^CREDENTIAL_ISSUER_SECRET=.*$/m, assignment)
    : `${env.trimEnd()}\n${assignment}\n`;
  writeFileSync('.env', updated, { mode: 0o600 });
}

const publicKey = ecMulGenerator(validate(secretHex));
console.log('\nCompliance credential issuer');
console.log('─'.repeat(70));
console.log(`  public x  ${publicKey.x}`);
console.log(`  public y  ${publicKey.y}`);
console.log('─'.repeat(70));
if (!show) {
  console.log('\n  Secret written to .env (gitignored, mode 600); it was not printed.');
}
console.log('  Back up the secret offline; losing it prevents issuing new credentials.\n');
