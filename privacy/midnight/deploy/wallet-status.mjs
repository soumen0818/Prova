// Read-only funding check for the deployment wallet.
//
// This intentionally waits only for the unshielded wallet. Faucet NIGHT appears there in seconds;
// shielded and DUST state can take 25-30 minutes to scan on a fresh machine and are not needed to
// answer the first deployment question: has this address been funded at all?

import { NETWORK_ENV, buildWallet, unshieldedAddress } from './new-wallet.mjs';

const fail = (message) => {
  console.error(`\n  ✗ ${message}\n`);
  process.exitCode = 1;
};

const seedHex = process.env.MIDNIGHT_WALLET_SEED?.trim().replace(/^"|"$/g, '');
if (!/^[0-9a-fA-F]{64}$/.test(seedHex ?? '')) {
  fail('MIDNIGHT_WALLET_SEED must be a 64-character hex seed. Run `npm run wallet:new` first.');
} else {
  const Rx = await import('rxjs');
  const { ZswapSecretKeys, DustSecretKey } = await import(
    '@midnight-ntwrk/midnight-js-protocol/ledger'
  );

  const done = (progress) =>
    typeof progress?.isStrictlyComplete === 'function' && progress.isStrictlyComplete();
  const timeoutMs = Number(process.env.WALLET_STATUS_TIMEOUT_MS ?? 120_000);

  let wallet;
  try {
    const built = await buildWallet(seedHex);
    wallet = built.wallet;
    const address = await unshieldedAddress(wallet);
    const zswapSecretKeys = ZswapSecretKeys.fromSeed(built.seeds.shielded);
    const dustSecretKey = DustSecretKey.fromSeed(built.seeds.dust);

    console.log(`\nDeployment wallet (${NETWORK_ENV.networkId})`);
    console.log('─'.repeat(70));
    console.log(`  address  ${address}`);
    process.stdout.write('  syncing unshielded history… ');
    await wallet.start(zswapSecretKeys, dustSecretKey);

    const state = await Rx.firstValueFrom(
      wallet.state().pipe(
        Rx.filter((next) => done(next.unshielded.progress)),
        Rx.timeout({ first: timeoutMs }),
      ),
    );
    const night = Object.values(state.unshielded.balances ?? {}).reduce(
      (total, value) => total + BigInt(value ?? 0n),
      0n,
    );

    console.log('done');
    console.log(`  NIGHT    ${night}`);
    console.log('─'.repeat(70));
    if (night === 0n) {
      console.log(`\n  Unfunded. Request Preprod tNIGHT at ${NETWORK_ENV.faucet}\n`);
    } else {
      console.log('\n  Funded. The wallet can proceed to full DUST synchronization.\n');
    }
  } catch (error) {
    fail(`wallet status check failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await wallet?.stop().catch(() => undefined);
  }
}
