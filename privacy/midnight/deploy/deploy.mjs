// Deploy Prova's authenticated compliance contract to Midnight Preprod (or explicit Preview).
//
// # What this deploys, and why the arguments matter
//
// Midnight authenticates a private credential and records a one-time authorization bound to the
// Stellar settlement nullifier. The experimental Midnight value-transfer contracts are compiled
// and tested, but deliberately not deployed: Stellar remains Prova's settlement layer. Constructor
// state fixes the policy authority, credential issuer, KYC minimum, and initial trusted policy time.
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
//   npm run wallet:new            # generate a Preprod deployment wallet
//   npm run deploy:check          # verify Preprod without spending
//   npm run deploy                # deploy to Preprod
//   npm run deploy:check:preview  # explicitly test Preview instead

import { getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { ecMulGenerator, signatureVerifyingKey } from '@midnight-ntwrk/compact-runtime';
import { validatePassword } from '@midnight-ntwrk/midnight-js-utils';

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as Compliance from '../build/contract/index.js';
import { NETWORK_ENV, buildWallet, unshieldedAddress } from './new-wallet.mjs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const net = NETWORK_ENV;
const PROOF_SERVER = net.proofServer;

// Non-zero by default so the deployed policy demonstrably rejects level-zero credentials.
const REQUIRED_KYC = BigInt(process.env.REQUIRED_KYC ?? '1');
const AUTO_POLICY_TIME = process.env.POLICY_TIME === undefined;
let POLICY_TIME = BigInt(process.env.POLICY_TIME ?? Math.floor(Date.now() / 1000));

const DRY_RUN = process.argv.includes('--dry-run');
const SYNC_TIMEOUT_MS = Number(process.env.SYNC_TIMEOUT_MS ?? 14_400_000);

const fail = (msg) => {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
};

const hex = (b) => Buffer.from(b).toString('hex');
if (REQUIRED_KYC < 0n || REQUIRED_KYC > 255n) {
  fail(`REQUIRED_KYC must be an integer from 0 to 255; got ${REQUIRED_KYC}.`);
}
if (POLICY_TIME < 0n || POLICY_TIME > 18_446_744_073_709_551_615n) {
  fail(`POLICY_TIME must fit in an unsigned 64-bit integer; got ${POLICY_TIME}.`);
}
if (!Number.isSafeInteger(SYNC_TIMEOUT_MS) || SYNC_TIMEOUT_MS < 60_000 || SYNC_TIMEOUT_MS > 2_147_483_647) {
  fail('SYNC_TIMEOUT_MS must be an integer from 60000 through 2147483647 milliseconds.');
}

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

const issuerSecretHex = process.env.CREDENTIAL_ISSUER_SECRET;
if (!issuerSecretHex) {
  fail(
    'CREDENTIAL_ISSUER_SECRET is not set. Run `npm run issuer:new` to create one safely.',
  );
}
if (!/^[0-9a-fA-F]{64}$/.test(issuerSecretHex)) {
  fail(
    `CREDENTIAL_ISSUER_SECRET must be 64 hex characters; got ${issuerSecretHex.length}.`,
  );
}

const JUBJUB_ORDER =
  6554484396890773809930967563523245729705921265872317281365359162392183254199n;
const issuerScalar = BigInt(`0x${issuerSecretHex}`) % JUBJUB_ORDER;
if (issuerScalar === 0n) {
  fail('CREDENTIAL_ISSUER_SECRET reduces to zero and cannot sign credentials. Generate a new key.');
}
const credentialIssuer = ecMulGenerator(issuerScalar);

const maintenanceSigningKey = process.env.CONTRACT_MAINTENANCE_KEY?.trim().replace(/^"|"$/g, '');
if (!maintenanceSigningKey) {
  fail(
    'CONTRACT_MAINTENANCE_KEY is not set. Run `npm run maintenance:new` to create one safely.',
  );
}
try {
  // Decode it before wallet sync. A malformed key must never be discovered after an hour-long scan.
  signatureVerifyingKey(maintenanceSigningKey);
} catch {
  fail('CONTRACT_MAINTENANCE_KEY is not a valid Midnight contract signing key.');
}

console.log(`\nProva — Midnight deployment`);
console.log('─'.repeat(70));
console.log(`  network          ${getNetworkId()}`);
console.log(`  node             ${net.node}`);
console.log(`  indexer          ${net.indexer}`);
console.log(`  proof server     ${PROOF_SERVER}`);
console.log(`  required KYC     ${REQUIRED_KYC}`);
console.log(`  policy authority ${hex(policyCommitment).slice(0, 32)}…`);
console.log(`  policy time      ${AUTO_POLICY_TIME ? 'current UTC time at submission' : POLICY_TIME}`);
console.log(`  issuer key       ${credentialIssuer.x.toString(16).slice(0, 32)}…`);
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

async function retry(fn, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  throw lastError;
}

const rpc = async (method, params = []) => {
  const r = await fetch(net.node, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
};

console.log('\nPreflight');
const ok = [
  await check('node', () =>
    retry(async () => {
      const chain = await rpc('system_chain');
      const health = await rpc('system_health');
      const syncStatus = health.isSyncing ? 'syncing reported' : 'ready';
      return `${chain}, ${health.peers} peers, ${syncStatus}`;
    }),
  ),
  await check('indexer', () =>
    retry(async () => {
      const r = await fetch(net.indexer, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ block { height } }' }),
        signal: AbortSignal.timeout(10_000),
      });
      const j = await r.json();
      if (j.errors) throw new Error(j.errors[0].message);
      return `block ${j.data.block.height}`;
    }),
  ),
  await check('proof server', async () => {
    const r = await fetch(PROOF_SERVER, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return 'local';
  }),
  await check('compiled artifacts', async () => {
    for (const key of ['proveEligibility', 'setMinKycLevel', 'setPolicyTime', 'setCredentialIssuer']) {
      await readFile(`build/keys/${key}.prover`);
    }
    return 'prover keys present';
  }),
];

if (!ok.every(Boolean)) {
  fail('preflight failed — nothing was deployed. Fix the above and re-run.');
}

console.log('\nContract');
console.log(
  `  compliance    constructor(authority = ${hex(policyCommitment).slice(0, 16)}…, minKyc = ${REQUIRED_KYC}, policyTime = ${AUTO_POLICY_TIME ? 'at submission' : POLICY_TIME})`,
);

if (DRY_RUN) {
  console.log('\n  Dry run complete. Everything above is reachable and consistent.');
  console.log('  Re-run without --dry-run to deploy.\n');
  console.log('  Deploying additionally needs a funded wallet:');
  console.log('    npm run wallet:new      generate one and print its address');
  console.log(`    then fund it at ${net.faucet}\n`);
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

// This is not an independent secret: anyone with the wallet seed already controls deployment.
// Prefix the high-entropy hash so it satisfies the SDK's three-character-class policy, then
// validate it before the expensive wallet sync rather than during post-finalization persistence.
const storagePassword = `Pv!${createHash('sha256')
  .update(`prova:private-state:v1:${seedHex}`)
  .digest('hex')}`;
validatePassword(storagePassword);

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

// A first sync scans the whole chain. Runtime varies substantially with CPU and current chain size;
// on Preprod the DUST scan has exceeded 45 minutes even while continuously making progress. Keep a
// generous guard and allow operators to override it without editing this file.
console.log('  syncing…                (a first Preprod sync can take well over 45 min)');
let state;
let lastProgressLine = '';
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
        if (line !== lastProgressLine) {
          console.log(line);
          lastProgressLine = line;
        }
      }),
      Rx.filter(allSynced),
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
      `    Faucet: ${net.faucet}`,
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
// Use the protocol package's documented access layer rather than relying on npm to hoist the
// transitive `@midnight-ntwrk/compact-js` package into node_modules.
const { CompiledContract } = await import('@midnight-ntwrk/midnight-js-protocol/compact-js');
const { ttlOneHour } = await import('@midnight-ntwrk/midnight-js-utils');

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

// Wallet synchronization can take hours. If policy time was not explicitly pinned, capture it
// immediately before building the constructor transaction, never at process start. Otherwise the
// freshly deployed expiry policy would already be stale before the first user call.
if (AUTO_POLICY_TIME) {
  POLICY_TIME = BigInt(Math.floor(Date.now() / 1000));
  console.log(`  policy time at submission ${POLICY_TIME}`);
}

const deployments = [
  {
    name: 'compliance',
    module: Compliance,
    zkDir: 'build',
    dts: 'build/contract/index.d.ts',
    args: [policyCommitment, credentialIssuer, REQUIRED_KYC, POLICY_TIME],
    verify: (led) => {
      if (hex(led.policyAuthority) !== hex(policyCommitment)) {
        throw new Error('policyAuthority does not match the secret provided');
      }
      if (
        led.credentialIssuer.x !== credentialIssuer.x ||
        led.credentialIssuer.y !== credentialIssuer.y
      ) {
        throw new Error('credentialIssuer does not match CREDENTIAL_ISSUER_SECRET');
      }
      if (led.minKycLevel !== REQUIRED_KYC) {
        throw new Error(`minKycLevel is ${led.minKycLevel}, expected ${REQUIRED_KYC}`);
      }
      if (led.policyTime !== POLICY_TIME) {
        throw new Error(`policyTime is ${led.policyTime}, expected ${POLICY_TIME}`);
      }
      if (!led.approvedSettlements.isEmpty()) {
        throw new Error('a new compliance contract must have no approved settlements');
      }
      return `minKycLevel = ${led.minKycLevel}, policyTime = ${led.policyTime}, issuer set`;
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
  // "does not contain a function-valued field named complianceCredential".
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

  const deployed = await deployContract(providers, {
    compiledContract: compiled,
    args: d.args,
    signingKey: maintenanceSigningKey,
  });
  const receipt = deployed.deployTxData.public;
  const contractAddress = receipt.contractAddress;
  console.log(`  address   ${contractAddress}`);
  console.log(`  tx id     ${receipt.txId}`);
  console.log(`  tx hash   ${receipt.txHash}`);
  console.log(`  block     ${receipt.blockHeight} (${receipt.blockHash})`);

  // Read the deployed state back and confirm the constructor did what was asked. Trusting that the
  // arguments landed is precisely the assumption that produced the zero-default bug.
  const onChain = await providers.publicDataProvider.queryContractState(contractAddress);
  console.log(`  verified  ${d.verify(d.module.ledger(onChain.data))}`);

  results.push({
    name: d.name,
    address: contractAddress,
    txId: String(receipt.txId),
    txHash: String(receipt.txHash),
    blockHeight: receipt.blockHeight,
    blockHash: String(receipt.blockHash),
    blockTimestamp: receipt.blockTimestamp,
    status: String(receipt.status),
  });
}

const deploymentManifest = {
  schemaVersion: 1,
  network: getNetworkId(),
  rpc: net.node,
  indexer: net.indexer,
  deployerAddress: address,
  maintenanceVerifyingKey: signatureVerifyingKey(maintenanceSigningKey),
  constructor: {
    policyAuthority: hex(policyCommitment),
    credentialIssuer: {
      x: credentialIssuer.x.toString(),
      y: credentialIssuer.y.toString(),
    },
    minKycLevel: REQUIRED_KYC.toString(),
    policyTime: POLICY_TIME.toString(),
  },
  contracts: results,
};
await mkdir('deployments', { recursive: true });
await writeFile(
  `deployments/${getNetworkId()}.json`,
  `${JSON.stringify(deploymentManifest, null, 2)}\n`,
  { mode: 0o644 },
);

console.log(`\n${'─'.repeat(70)}`);
console.log(`Deployed to Midnight ${getNetworkId()}:\n`);
for (const r of results) console.log(`  ${r.name.padEnd(12)} ${r.address}`);
console.log('\n  Keep POLICY_SECRET and CREDENTIAL_ISSUER_SECRET offline and backed up.\n');

// The wallet holds open websockets; without this the process hangs after a successful deployment,
// which reads as a failure.
await wallet.stop();
process.exit(0);
