// Generate a deployment wallet and print the address to fund.
//
// # Why this exists rather than reusing a Lace wallet
//
// Lace shows a 24-word mnemonic; the SDK's wallet builder takes a 32-byte hex seed. The mapping
// between the two is Lace's own — not plain BIP39. Three standard derivations were tried against a
// known Lace address (BIP39 seed first 32 bytes, last 32 bytes, and raw entropy) and none
// reproduced it, so a Lace mnemonic cannot be turned into a deployment seed without reimplementing
// whatever Lace does internally.
//
// Generating the seed with the same SDK that will consume it sidesteps that entirely. The wallet
// this produces is a deployment key, not a user wallet: its only job is to pay fees and own the
// deployed contracts.
//
// Usage:
//   node deploy/new-wallet.mjs           # generate, print address, save seed to .env
//   node deploy/new-wallet.mjs --show    # print the address for the seed already in .env

import { setNetworkId, getNetworkId } from '@midnight-ntwrk/midnight-js-network-id';

const NETWORK = 'preview';
setNetworkId(NETWORK);

const { FluentWalletBuilder } = await import('@midnight-ntwrk/testkit-js');
const { LedgerParameters } = await import('@midnight-ntwrk/midnight-js-protocol/ledger');
const { UnshieldedAddress } = await import('@midnight-ntwrk/wallet-sdk-address-format');
const Rx = await import('rxjs');
const { randomBytes } = await import('node:crypto');
const { readFileSync, writeFileSync, existsSync } = await import('node:fs');

export const PREVIEW_ENV = {
  walletNetworkId: NETWORK,
  networkId: NETWORK,
  indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
  indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  node: 'https://rpc.preview.midnight.network',
  nodeWS: 'wss://rpc.preview.midnight.network',
  proofServer: process.env.PROOF_SERVER ?? 'http://localhost:6300',
  faucet: undefined,
};

/** Dust options as the official example configures them for a public network. */
export const dustOptions = () => ({
  ledgerParams: LedgerParameters.initialParameters(),
  additionalFeeOverhead: 1_000n,
  feeBlocksMargin: 5,
});

/** Build (without starting) the wallet for a hex seed. */
export async function buildWallet(seedHex, env = PREVIEW_ENV) {
  const builder = FluentWalletBuilder.forEnvironment(env).withDustOptions(dustOptions());
  return builder.withSeed(seedHex).buildWithoutStarting();
}

/** The unshielded address — this is what the faucet funds. */
export async function unshieldedAddress(wallet) {
  const state = await Rx.firstValueFrom(wallet.unshielded.state);
  return UnshieldedAddress.codec.encode(getNetworkId(), state.address).toString();
}

// --- CLI ----------------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const show = process.argv.includes('--show');
  let seedHex;

  if (show) {
    if (!existsSync('.env')) {
      console.error('\n  ✗ no .env file — run without --show to generate a wallet.\n');
      process.exit(1);
    }
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.startsWith('MIDNIGHT_WALLET_SEED='));
    seedHex = line?.split('=', 2)[1]?.trim().replace(/^"|"$/g, '') ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      console.error(
        '\n  ✗ MIDNIGHT_WALLET_SEED in .env is not a 64-character hex seed.\n' +
        '    A Lace 24-word mnemonic will not work here — run without --show to\n' +
        '    generate a deployment wallet instead.\n',
      );
      process.exit(1);
    }
  } else {
    seedHex = randomBytes(32).toString('hex');
  }

  const { wallet } = await buildWallet(seedHex);
  const address = await unshieldedAddress(wallet);

  console.log(`\nDeployment wallet (${NETWORK})`);
  console.log('─'.repeat(70));
  console.log(`  address  ${address}`);

  if (show) {
    console.log('─'.repeat(70));
    console.log('\n  Fund this address, then run:  npm run deploy\n');
  } else {
    // Persist the seed rather than printing it, so it does not end up in shell history or a
    // screenshot. The address above is public and safe to paste anywhere.
    const existing = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
    const updated = existing.includes('MIDNIGHT_WALLET_SEED=')
      ? existing.replace(/^MIDNIGHT_WALLET_SEED=.*$/m, `MIDNIGHT_WALLET_SEED="${seedHex}"`)
      : `${existing.trimEnd()}\nMIDNIGHT_WALLET_SEED="${seedHex}"\n`;
    writeFileSync('.env', updated, { mode: 0o600 });
    console.log('─'.repeat(70));
    console.log('\n  Seed written to .env (gitignored, mode 600). It was not printed here.');
    console.log('\n  Next:');
    console.log('    1. Fund the address above at https://midnight-tmnight-preview.nethermind.dev/');
    console.log('    2. Wait for tDUST to accrue from the tNIGHT received');
    console.log('    3. npm run deploy\n');
  }

  process.exit(0);
}
