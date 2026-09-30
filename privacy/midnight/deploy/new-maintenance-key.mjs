// Create the signing key used as the Midnight contract-maintenance authority.
// The secret is written directly to the gitignored .env file and is never printed.

import { sampleSigningKey, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const ENV_KEY = 'CONTRACT_MAINTENANCE_KEY';

const fail = (message) => {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
};

const readConfiguredSecret = (contents) => {
  const match = contents.match(/^CONTRACT_MAINTENANCE_KEY=(.*)$/m);
  return match?.[1]?.trim().replace(/^"|"$/g, '') ?? '';
};

const validate = (signingKey) => {
  try {
    return signatureVerifyingKey(signingKey);
  } catch {
    fail(`${ENV_KEY} is not a valid Midnight contract signing key.`);
  }
};

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
const existing = readConfiguredSecret(env);
const show = process.argv.includes('--show');

let signingKey;
if (show) {
  if (!existing) fail(`${ENV_KEY} is not configured; run npm run maintenance:new first.`);
  signingKey = existing;
} else {
  if (existing) {
    fail(
      `${ENV_KEY} is already configured. Refusing to rotate it implicitly; ` +
        'change maintenance authority on-chain deliberately.',
    );
  }
  signingKey = sampleSigningKey();
  const assignment = `${ENV_KEY}="${signingKey}"`;
  const updated = /^CONTRACT_MAINTENANCE_KEY=.*$/m.test(env)
    ? env.replace(/^CONTRACT_MAINTENANCE_KEY=.*$/m, assignment)
    : `${env.trimEnd()}\n${assignment}\n`;
  writeFileSync('.env', updated, { mode: 0o600 });
}

console.log('\nContract maintenance authority');
console.log('─'.repeat(70));
console.log(`  public key  ${validate(signingKey)}`);
console.log('─'.repeat(70));
if (!show) console.log('\n  Signing key written to .env (gitignored, mode 600); it was not printed.');
console.log('  Back it up offline; losing it prevents verifier-key or authority maintenance.\n');
