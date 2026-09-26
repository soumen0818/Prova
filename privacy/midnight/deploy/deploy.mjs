// Deploy Prova's Compact contracts to a Midnight network.
//
// # What this deploys, and why the arguments matter
//
// Both contracts take constructor arguments that decide what the deployed instance *enforces*, and
// a Midnight contract's ledger is fixed at construction — there is no migration. Getting these
// wrong means redeploying at a new address, which orphans every note in the old tree.
//
//   transfer(initialRequiredKyc)               the corridor minimum, permanently
//   compliance(policyCommitment, initialMinKyc) the policy authority, permanently
//
// Deployed without a constructor, both defaulted to zero: a corridor minimum of 0 admits every
// credential including level 0, and a policy authority of 32 zero bytes is a hash nobody can
// produce a preimage for, so `setMinKycLevel` could never be called by anyone. A compliance layer
// enforcing nothing, with no way to fix it. That is the bug this script exists on the other side of.
//
// # The policy secret
//
// `POLICY_SECRET` controls the corridor policy forever. It is read from the environment and never
// written to disk by this script, because a key committed to a repository is not a key.
//
// The contract stores only `policyCommitment(secret)` — publishing that reveals nothing, which is
// the whole reason the authority is a commitment rather than an address.
//
// # Usage
//
//   export POLICY_SECRET=$(openssl rand -hex 32)      # keep this somewhere safe
//   export MIDNIGHT_WALLET_SEED=<your seed>
//   node deploy/deploy.mjs --network preview [--dry-run]
//
// `--dry-run` resolves and prints everything that would be deployed, and contacts the network only
// to read. Run it first.

import { readFile } from 'node:fs/promises';
import * as Transfer from '../build-transfer/contract/index.js';
import * as Compliance from '../build/contract/index.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Verified live 2026-09-26 — see bench/NETWORK.md. The endpoints Prova previously had on record
// were for `testnet-02`, which Midnight retired; those hostnames no longer resolve.
const NETWORKS = {
  preview: {
    node: 'https://rpc.preview.midnight.network',
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    indexerWs: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
  undeployed: {
    node: 'http://localhost:9944',
    indexer: 'http://localhost:8088/api/v4/graphql',
    indexerWs: 'ws://localhost:8088/api/v4/graphql/ws',
  },
};

// Always local. The proof server receives the witness — spending key, amounts, recipients — so
// pointing at someone else's would hand them exactly what this privacy layer exists to protect.
const PROOF_SERVER = process.env.PROOF_SERVER ?? 'http://localhost:6300';

/**
 * The corridor's minimum KYC level, applied to both contracts.
 *
 * Non-zero on purpose: at 0 the check runs on every transfer and can never reject, so a deployment
 * would demonstrate no enforcement at all. 1 is low enough to test against and high enough that
 * level 0 is genuinely refused.
 */
const REQUIRED_KYC = BigInt(process.env.REQUIRED_KYC ?? '1');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const DRY_RUN = args.includes('--dry-run');
const NETWORK = flag('network', 'preview');

// ---------------------------------------------------------------------------
// Preflight — fail before touching the chain, not halfway through
// ---------------------------------------------------------------------------

const fail = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

const net = NETWORKS[NETWORK];
if (!net) fail(`unknown network '${NETWORK}'. Known: ${Object.keys(NETWORKS).join(', ')}`);

const secretHex = process.env.POLICY_SECRET;
if (!secretHex) {
  fail(
    'POLICY_SECRET is not set.\n' +
    '    This key controls the corridor policy permanently and cannot be changed after deployment.\n' +
    '    Generate one and keep it somewhere you will still have it later:\n\n' +
    '      export POLICY_SECRET=$(openssl rand -hex 32)',
  );
}
if (!/^[0-9a-fA-F]{64}$/.test(secretHex)) {
  fail(`POLICY_SECRET must be 64 hex characters (32 bytes); got ${secretHex.length} characters.`);
}

const policySecret = Uint8Array.from(Buffer.from(secretHex, 'hex'));
if (policySecret.every((b) => b === 0)) {
  fail('POLICY_SECRET is all zeros — that is the unreachable default this constructor exists to avoid.');
}

// Derived through the contract's own exported circuit, never rehashed here. If this script and the
// contract disagreed about the derivation, the deployed authority would be one no secret controls —
// silently reproducing the exact bug being fixed.
const policyCommitment = Compliance.pureCircuits.policyCommitment(policySecret);

const hex = (b) => Buffer.from(b).toString('hex');

console.log(`\nProva — Midnight deployment`);
console.log(`${'─'.repeat(60)}`);
console.log(`  network         ${NETWORK}`);
console.log(`  node            ${net.node}`);
console.log(`  indexer         ${net.indexer}`);
console.log(`  proof server    ${PROOF_SERVER}`);
console.log(`  required KYC    ${REQUIRED_KYC}`);
console.log(`  policy authority ${hex(policyCommitment).slice(0, 32)}…`);
console.log(`  mode            ${DRY_RUN ? 'DRY RUN — nothing will be deployed' : 'LIVE'}`);
console.log(`${'─'.repeat(60)}\n`);

// ---------------------------------------------------------------------------
// Reachability — check everything before spending a single tDUST
// ---------------------------------------------------------------------------

async function check(label, fn) {
  process.stdout.write(`  ${label.padEnd(24)}`);
  try {
    const detail = await fn();
    console.log(`ok${detail ? `  ${detail}` : ''}`);
    return true;
  } catch (e) {
    console.log(`FAILED — ${e.message}`);
    return false;
  }
}

const rpc = async (method, params = []) => {
  const r = await fetch(net.node, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

console.log('Preflight');
const ok = [
  await check('node', async () => {
    const chain = await rpc('system_chain');
    const health = await rpc('system_health');
    if (health.isSyncing) throw new Error('node is still syncing');
    return `${chain}, ${health.peers} peers`;
  }),
  await check('indexer', async () => {
    const r = await fetch(net.indexer, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ block { height } }' }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return `block ${j.data.block.height}`;
  }),
  await check('proof server', async () => {
    const r = await fetch(PROOF_SERVER, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return 'local';
  }),
  await check('compiled artifacts', async () => {
    for (const [dir, keys] of [
      ['build-transfer', ['transfer', 'deposit']],
      ['build', ['proveEligibility', 'setMinKycLevel']],
    ]) {
      for (const k of keys) await readFile(`${dir}/keys/${k}.prover`);
    }
    return 'prover keys present';
  }),
];

if (!ok.every(Boolean)) {
  fail('preflight failed — nothing was deployed. Fix the above and re-run.');
}

// ---------------------------------------------------------------------------
// What would be deployed
// ---------------------------------------------------------------------------

console.log('\nContracts');
console.log(`  transfer      constructor(requiredKyc = ${REQUIRED_KYC})`);
console.log(`  compliance    constructor(policyAuthority = ${hex(policyCommitment).slice(0, 16)}…, minKyc = ${REQUIRED_KYC})`);

if (DRY_RUN) {
  console.log('\n  Dry run complete. Everything above is reachable and consistent.');
  console.log('  Re-run without --dry-run to deploy.\n');
  console.log('  Deploying additionally needs a funded wallet:');
  console.log('    1. Get tNIGHT from https://midnight-tmnight-preview.nethermind.dev/');
  console.log('    2. Register it for tDUST generation (Lace, or the wallet SDK)');
  console.log('    3. export MIDNIGHT_WALLET_SEED=<seed>\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Live deployment
// ---------------------------------------------------------------------------

if (!process.env.MIDNIGHT_WALLET_SEED) {
  fail(
    'MIDNIGHT_WALLET_SEED is not set — a funded wallet is required to pay deployment fees.\n' +
    '    1. Request tNIGHT from https://midnight-tmnight-preview.nethermind.dev/\n' +
    '    2. Register it for tDUST generation (Lace, or the wallet SDK)\n' +
    '    3. export MIDNIGHT_WALLET_SEED=<seed>\n\n' +
    '    Run with --dry-run to verify everything else first.',
  );
}

// Imported here rather than at the top so `--dry-run` works without a wallet installed.
const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');

const deployments = [
  {
    name: 'transfer',
    module: Transfer,
    zkDir: 'build-transfer',
    args: [REQUIRED_KYC],
    verify: (led) => {
      if (led.requiredKycLevel !== REQUIRED_KYC) {
        throw new Error(`requiredKycLevel is ${led.requiredKycLevel}, expected ${REQUIRED_KYC}`);
      }
      return `requiredKycLevel = ${led.requiredKycLevel}`;
    },
  },
  {
    name: 'compliance',
    module: Compliance,
    zkDir: 'build',
    args: [policyCommitment, REQUIRED_KYC],
    verify: (led) => {
      if (hex(led.policyAuthority) === '00'.repeat(32)) {
        throw new Error('policyAuthority is the unreachable zero default');
      }
      if (hex(led.policyAuthority) !== hex(policyCommitment)) {
        throw new Error('policyAuthority does not match the secret provided');
      }
      return `minKycLevel = ${led.minKycLevel}, authority set`;
    },
  },
];

const results = [];
for (const d of deployments) {
  console.log(`\nDeploying ${d.name}…`);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: `prova-${d.name}` }),
    publicDataProvider: indexerPublicDataProvider(net.indexer, net.indexerWs),
    zkConfigProvider: new NodeZkConfigProvider(d.zkDir),
    proofProvider: httpClientProofProvider(PROOF_SERVER),
    walletProvider: undefined,
    midnightProvider: undefined,
  };

  const deployed = await deployContract(providers, {
    contract: new d.module.Contract({}),
    args: d.args,
  });

  const address = deployed.deployTxData.public.contractAddress;
  console.log(`  address   ${address}`);

  // Read the deployed state back and confirm the constructor did what was asked. Trusting that the
  // arguments landed is precisely the assumption that produced the zero-default bug.
  const state = await providers.publicDataProvider.queryContractState(address);
  const detail = d.verify(d.module.ledger(state.data));
  console.log(`  verified  ${detail}`);

  results.push({ name: d.name, address });
}

console.log(`\n${'─'.repeat(60)}`);
console.log('Deployed:');
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.address}`);
console.log(`\n  Keep POLICY_SECRET safe — it is the only way to change the corridor policy.\n`);
