// Deploy Prova's Compact contracts to the Midnight Preview network.
//
// # What this deploys, and why the arguments matter
//
// Both contracts take constructor arguments that decide what the deployed instance *enforces*, and
// a Midnight contract's ledger is fixed at construction — there is no migration. Getting these
// wrong means redeploying at a new address, which orphans every note in the old tree.
//
//   transfer(initialRequiredKyc)                the corridor minimum, permanently
//   compliance(policyCommitment, initialMinKyc) the policy authority, permanently
//
// Deployed without a constructor, both defaulted to zero: a corridor minimum of 0 admits every
// credential including level 0, and a policy authority of 32 zero bytes is a hash nobody can
// produce a preimage for, so `setMinKycLevel` could never be called by anyone. A compliance layer
// enforcing nothing, with no way to fix it. That is the bug this script exists on the other side of.
//
// # The wallet
//
// `MIDNIGHT_WALLET_SEED` is a 32-byte hex seed, NOT a Lace mnemonic. Lace's 24 words map to a seed
// by its own internal scheme — three standard BIP39 derivations were tried against a known Lace
// address and none reproduced it. Generate a deployment wallet with `npm run wallet:new` instead;
// it uses the same SDK that consumes the seed, so the two agree by construction.
//
// # The policy secret
//
// `POLICY_SECRET` controls the corridor policy forever. The contract stores only
// `policyCommitment(secret)` — publishing that reveals nothing, which is the whole reason the
// authority is a commitment rather than an address.
//
// # Usage
//
//   npm run wallet:new         # generate a deployment wallet, print the address to fund
//   npm run deploy:check       # verify everything without spending
//   npm run deploy

import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

// Must happen before anything that encodes an address or builds a wallet: the network identifier is
// global state read at construction time, and `preview` is not one of the values the older
// `@midnight-ntwrk/wallet` enum knew about.
setNetworkId('preview');

import { readFile } from 'node:fs/promises';
import * as Transfer from '../build-transfer/contract/index.js';
import * as Compliance from '../build/contract/index.js';
import { PREVIEW_ENV, buildWallet, unshieldedAddress } from './new-wallet.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const net = PREVIEW_ENV;
const PROOF_SERVER = net.proofServer;

/**
 * The corridor's minimum KYC level, applied to both contracts.
 *
 * Non-zero on purpose: at 0 the check runs on every transfer and can never reject, so a deployment
 * would demonstrate no enforcement at all. 1 is low enough to test against and high enough that
 * level 0 is genuinely refused.
 */
const REQUIRED_KYC = BigInt(process.env.REQUIRED_KYC ?? '1');

const DRY_RUN = process.argv.includes('--dry-run');

const fail = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

const hex = (b) => Buffer.from(b).toString('hex');

// ---------------------------------------------------------------------------
// Preflight — fail before touching the chain, not halfway through
// ---------------------------------------------------------------------------

const secretHex = process.env.POLICY_SECRET;
if (!secretHex) {
  fail(
    'POLICY_SECRET is not set.\n' +
    '    This key controls the corridor policy permanently and cannot be changed after deployment.\n' +
    '    Generate one and keep it somewhere you will still have it later:\n\n' +
    '      openssl rand -hex 32',
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

console.log(`\nProva — Midnight deployment`);
console.log('─'.repeat(70));
console.log(`  network          ${getNetworkId()}`);
console.log(`  node             ${net.node}`);
console.log(`  indexer          ${net.indexer}`);
console.log(`  proof server     ${PROOF_SERVER}`);
console.log(`  required KYC     ${REQUIRED_KYC}`);
console.log(`  policy authority ${hex(policyCommitment).slice(0, 32)}…`);
console.log(`  mode             ${DRY_RUN ? 'DRY RUN — nothing will be deployed' : 'LIVE'}`);
console.log('─'.repeat(70));

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

console.log('\nPreflight');
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

console.log('\nContracts');
console.log(`  transfer      constructor(requiredKyc = ${REQUIRED_KYC})`);
console.log(`  compliance    constructor(policyAuthority = ${hex(policyCommitment).slice(0, 16)}…, minKyc = ${REQUIRED_KYC})`);

if (DRY_RUN) {
  console.log('\n  Dry run complete. Everything above is reachable and consistent.');
  console.log('  Re-run without --dry-run to deploy.\n');
  console.log('  Deploying additionally needs a funded wallet:');
  console.log('    npm run wallet:new      generate one and print its address');
  console.log('    then fund it at https://midnight-tmnight-preview.nethermind.dev/\n');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------

const seedHex = process.env.MIDNIGHT_WALLET_SEED?.trim().replace(/^"|"$/g, '');
if (!seedHex) {
  fail('MIDNIGHT_WALLET_SEED is not set. Run `npm run wallet:new` to generate a deployment wallet.');
}
if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
  fail(
    'MIDNIGHT_WALLET_SEED must be a 64-character hex seed.\n' +
    '    A Lace 24-word mnemonic will not work: Lace derives its seed by its own scheme, which\n' +
    '    does not match any standard BIP39 mapping. Run `npm run wallet:new` instead.',
  );
}

const Rx = await import('rxjs');
const { ZswapSecretKeys, DustSecretKey } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { createKeystore } = await import('@midnight-ntwrk/wallet-sdk-unshielded-wallet');
const { HDWallet, Roles } = await import('@midnight-ntwrk/wallet-sdk-hd');

console.log('\nWallet');
process.stdout.write('  building…               ');
const { wallet, seeds, keystore } = await buildWallet(seedHex);
const zswapSecretKeys = ZswapSecretKeys.fromSeed(seeds.shielded);
const dustSecretKey = DustSecretKey.fromSeed(seeds.dust);
console.log('ok');

const address = await unshieldedAddress(wallet);
console.log(`  address                 ${address.slice(0, 40)}…`);

process.stdout.write('  starting…               ');
await wallet.start(zswapSecretKeys, dustSecretKey);
console.log('ok');

/**
 * Whether one wallet's sync progress is complete.
 *
 * `isStrictlyComplete()` rather than a `synced` boolean: the facade tracks shielded, unshielded and
 * dust separately, and all three must finish before balances can be trusted. An earlier version of
 * this script waited on a `syncProgress.synced` field that the facade does not expose, which is a
 * condition that never becomes true.
 */
const done = (p) => typeof p?.isStrictlyComplete === 'function' && p.isStrictlyComplete();
const allSynced = (s) => done(s.shielded.state.progress) && done(s.unshielded.progress) && done(s.dust.state.progress);

// A first sync scans the whole chain: shielded and dust each walk ~255k indices at roughly 160
// per second, so 25-30 minutes is normal and 10 was simply wrong. The unshielded wallet finishes in
// seconds by comparison, which is why funds show up long before the wallet is usable.
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 2_700_000);
console.log('  syncing…                (first sync scans the chain — expect 25-30 min)');
let state;
const pctOf = (p) => {
  const at = Number(p?.appliedIndex ?? 0);
  const to = Number(p?.highestRelevantWalletIndex ?? 0);
  return to > 0 ? Math.min(100, Math.floor((at / to) * 100)) : 0;
};
try {
  state = await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.tap((s) => {
        const line = `    shielded ${String(pctOf(s.shielded.state.progress)).padStart(3)}%  `
          + `dust ${String(pctOf(s.dust.state.progress)).padStart(3)}%  `
          + `unshielded ${done(s.unshielded.progress) ? 'done' : '…'}`;
        process.stdout.write(`\r${line}`);
      }),
      Rx.filter(allSynced),
      Rx.tap(() => process.stdout.write('\n')),
      Rx.timeout({ first: SYNC_TIMEOUT_MS }),
    ),
  );
} catch {
  await wallet.stop();
  fail(
    `wallet did not finish syncing within ${SYNC_TIMEOUT_MS / 1000}s.\n` +
    '    A first sync can take several minutes. Retry, or raise SYNC_TIMEOUT_MS.',
  );
}
console.log('ok');

const nightBalances = state.unshielded.balances ?? {};
const dustBalance = state.dust.balance(new Date());
console.log(`  night                   ${Object.values(nightBalances).reduce((a, b) => a + BigInt(b ?? 0n), 0n)}`);
console.log(`  dust                    ${dustBalance}`);

// ---------------------------------------------------------------------------
// Dust — fees are paid in dust, which is generated by registering NIGHT UTXOs
// ---------------------------------------------------------------------------

if (dustBalance === 0n) {
  const unregistered = state.unshielded.availableCoins.filter((c) => !c.meta.registeredForDustGeneration);

  if (unregistered.length === 0) {
    await wallet.stop();
    fail(
      'no dust, and no unregistered NIGHT to generate it from.\n' +
      `    Fund this address, then re-run:\n      ${address}\n` +
      '    Faucet: https://midnight-tmnight-preview.nethermind.dev/',
    );
  }

  console.log(`\nDust generation (${unregistered.length} UTXO${unregistered.length === 1 ? '' : 's'})`);
  process.stdout.write('  registering…            ');

  // The unshielded signing key is derived separately from the wallet's own seed, at the
  // NightExternal role — registration is an unshielded transaction and must be signed as such.
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, 'hex'));
  const derived = hd.hdWallet.selectAccount(0).selectRole(Roles.NightExternal).deriveKeyAt(0);
  if (derived.type === 'keyOutOfBounds') {
    await wallet.stop();
    fail('could not derive the unshielded signing key from the wallet seed.');
  }
  const unshieldedKeystore = createKeystore(derived.key, getNetworkId());
  const dustState = await wallet.dust.waitForSyncedState();

  const recipe = await wallet.registerNightUtxosForDustGeneration(
    unregistered,
    unshieldedKeystore.getPublicKey(),
    (payload) => unshieldedKeystore.signData(payload),
    dustState.address,
  );
  const txId = await wallet.submitTransaction(await wallet.finalizeRecipe(recipe));
  console.log(`ok  tx ${String(txId).slice(0, 20)}…`);

  process.stdout.write('  waiting for dust…       ');
  try {
    const funded = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.filter((s) => s.dust.balance(new Date()) > 0n),
        Rx.timeout({ first: SYNC_TIMEOUT_MS }),
      ),
    );
    console.log(`ok  ${funded.dust.balance(new Date())}`);
  } catch {
    await wallet.stop();
    fail(
      'dust did not appear in time. Registration was submitted — dust accrues gradually,\n' +
      '    so re-running in a few minutes should find it.',
    );
  }
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

const { deployContract } = await import('@midnight-ntwrk/midnight-js-contracts');
const { NodeZkConfigProvider } = await import('@midnight-ntwrk/midnight-js-node-zk-config-provider');
const { indexerPublicDataProvider } = await import('@midnight-ntwrk/midnight-js-indexer-public-data-provider');
const { levelPrivateStateProvider } = await import('@midnight-ntwrk/midnight-js-level-private-state-provider');
const { httpClientProofProvider } = await import('@midnight-ntwrk/midnight-js-http-client-proof-provider');
const { CompiledContract } = await import('@midnight-ntwrk/compact-js');
const { ttlOneHour } = await import('@midnight-ntwrk/midnight-js-utils');
const { createHash } = await import('node:crypto');

// The wallet adapter `midnight-js-contracts` expects. Note these are METHODS, not properties — an
// earlier version passed plain fields and would have failed here even with a working wallet.
const walletProvider = {
  getCoinPublicKey: () => zswapSecretKeys.coinPublicKey,
  getEncryptionPublicKey: () => zswapSecretKeys.encryptionPublicKey,
  balanceTx: async (tx, ttl = ttlOneHour()) => {
    const recipe = await wallet.balanceUnboundTransaction(
      tx,
      { shieldedSecretKeys: zswapSecretKeys, dustSecretKey },
      { ttl },
    );
    const signed = await wallet.signRecipe(recipe, (payload) => keystore.signData(payload));
    return wallet.finalizeRecipe(signed);
  },
};

const midnightProvider = { submitTx: (tx) => wallet.submitTransaction(tx) };

// The local private-state store is encrypted at rest and scoped by account, so two wallets on one
// machine cannot read each other's state. The password is derived from the wallet seed rather than
// prompted for: it keeps deployment non-interactive, and it is not an additional secret — anyone
// holding the seed controls the wallet anyway.
const storagePassword = createHash('sha256').update(`prova:private-state:v1:${seedHex}`).digest('hex');

const deployments = [
  {
    name: 'transfer',
    module: Transfer,
    zkDir: 'build-transfer',
    dts: 'build-transfer/contract/index.d.ts',
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
    dts: 'build/contract/index.d.ts',
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

/**
 * The witness names a contract declares, read from the compiler's generated typings.
 *
 * Parsed rather than hardcoded so the list cannot drift from the contract: adding a witness to a
 * .compact file and forgetting to add it here would otherwise fail at deploy time, after the fees.
 */
async function witnessNames(dtsPath) {
  const dts = await readFile(dtsPath, 'utf8');
  const block = dts.match(/export type Witnesses<PS> = \{([\s\S]*?)\n\}/);
  if (!block) throw new Error(`could not find the Witnesses block in ${dtsPath}`);
  return [...block[1].matchAll(/^\s{2}([A-Za-z0-9_]+)\(/gm)].map((m) => m[1]);
}

const results = [];
for (const d of deployments) {
  console.log(`\nDeploying ${d.name}…`);

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: `prova-${d.name}`,
      privateStoragePasswordProvider: async () => storagePassword,
      accountId: address,
    }),
    publicDataProvider: indexerPublicDataProvider(net.indexer, net.indexerWS),
    zkConfigProvider: new NodeZkConfigProvider(d.zkDir),
    proofProvider: httpClientProofProvider(PROOF_SERVER),
    walletProvider,
    midnightProvider,
  };

  // `compiledContract`, not `contract`: deployContract takes the compiled form, which carries the
  // witnesses and the on-disk ZK assets alongside the contract class.
  //
  // The witnesses must all be present even though deployment only runs the *constructor*, which
  // reads none of them: the generated `Contract` class validates that every declared witness is a
  // function at construction time and throws otherwise. Passing `{}` fails with
  // "does not contain a function-valued field named spenderSecretKey".
  //
  // They are stubs that throw, deliberately. Deployment must never call one, so a stub that returns
  // a plausible zero value would hide a real bug behind a silently wrong proof; one that throws
  // turns the same mistake into a stack trace naming the witness.
  const witnesses = Object.fromEntries(
    (await witnessNames(d.dts)).map((name) => [
      name,
      () => {
        throw new Error(
          `witness '${name}' was called during deployment — the constructor should not read witnesses`,
        );
      },
    ]),
  );

  const compiled = CompiledContract.make(d.name, d.module.Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(d.zkDir),
  );

  const deployed = await deployContract(providers, { compiledContract: compiled, args: d.args });
  const contractAddress = deployed.deployTxData.public.contractAddress;
  console.log(`  address   ${contractAddress}`);

  // Read the deployed state back and confirm the constructor did what was asked. Trusting that the
  // arguments landed is precisely the assumption that produced the zero-default bug.
  const onChain = await providers.publicDataProvider.queryContractState(contractAddress);
  console.log(`  verified  ${d.verify(d.module.ledger(onChain.data))}`);

  results.push({ name: d.name, address: contractAddress });
}

console.log(`\n${'─'.repeat(70)}`);
console.log('Deployed to Midnight Preview:\n');
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.address}`);
console.log('\n  Keep POLICY_SECRET safe — it is the only way to change the corridor policy.\n');

// The wallet holds open websockets; without this the process hangs after a successful deployment,
// which reads as a failure.
await wallet.stop();
process.exit(0);
