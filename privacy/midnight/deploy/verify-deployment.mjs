// Read-only verification of the public Preprod deployment receipt and constructor state.
// No wallet, .env file, or private key is required.

import { readFile } from 'node:fs/promises';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import * as Compliance from '../build/contract/index.js';

const manifest = JSON.parse(await readFile('deployments/preprod.json', 'utf8'));
async function retryIndexer(operation, attempts = 5) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
        console.warn(`Indexer request failed (${attempt}/${attempts}); retrying in ${delay} ms`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

if (manifest.network !== 'preprod' || manifest.contracts?.length !== 1) {
  throw new Error('Expected exactly one Midnight Preprod contract in deployments/preprod.json');
}
const contract = manifest.contracts[0];
if (contract.name !== 'compliance' || !/^[0-9a-f]{64}$/.test(contract.address)) {
  throw new Error('Deployment manifest has no valid compliance contract address');
}
setNetworkId('preprod');

const provider = indexerPublicDataProvider(
  manifest.indexer,
  manifest.indexer.replace(/^https:/, 'wss:').replace(/\/api\/v4\/graphql$/, '/api/v4/graphql/ws'),
);
const deployed = await retryIndexer(() => provider.queryDeployContractState(contract.address));
if (!deployed) throw new Error(`Contract ${contract.address} is absent from the Preprod indexer`);
const ledger = Compliance.ledger(deployed.data);
const expected = manifest.constructor;
const actualAuthority = Buffer.from(ledger.policyAuthority).toString('hex');
const expectedIssuer = expected.credentialIssuer;
if (
  actualAuthority !== expected.policyAuthority ||
  ledger.credentialIssuer.x !== BigInt(expectedIssuer.x) ||
  ledger.credentialIssuer.y !== BigInt(expectedIssuer.y) ||
  ledger.minKycLevel !== BigInt(expected.minKycLevel) ||
  ledger.policyTime !== BigInt(expected.policyTime) ||
  !ledger.approvedSettlements.isEmpty()
) {
  throw new Error('On-chain constructor state differs from the public deployment manifest');
}

const query = `query VerifyBlock($offset: BlockOffset) {
  block(offset: $offset) {
    height hash timestamp
    transactions {
      hash
      contractActions { address }
      ... on RegularTransaction {
        identifiers
        transactionResult { status }
      }
    }
  }
}`;
const result = await retryIndexer(async () => {
  const response = await fetch(manifest.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { offset: { height: contract.blockHeight } } }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Indexer returned HTTP ${response.status}`);
  return response.json();
});
if (result.errors?.length) throw new Error(result.errors[0].message);
const block = result.data?.block;
if (!block || block.hash !== contract.blockHash) {
  throw new Error('Deployment block is missing or its hash differs from the receipt');
}
const matchingTx = block.transactions.find((tx) => tx.hash === contract.txHash);
if (!matchingTx || matchingTx.transactionResult?.status !== 'SUCCESS') {
  throw new Error('Deployment transaction is missing or was not successful');
}
const actionIndex = matchingTx.contractActions.findIndex(
  (action) => action.address === contract.address,
);
if (actionIndex < 0 || matchingTx.identifiers?.[actionIndex] !== contract.txId) {
  throw new Error('Deployment address and transaction ID do not match the receipt');
}

console.log('Midnight Preprod deployment verified');
console.log(`  contract     ${contract.address}`);
console.log(`  tx id        ${contract.txId}`);
console.log(`  tx hash      ${contract.txHash}`);
console.log(`  block        ${contract.blockHeight} (${contract.blockHash})`);
console.log(`  min KYC      ${ledger.minKycLevel}`);
console.log(`  policy time  ${ledger.policyTime}`);
console.log('  constructor  matches the on-chain deployment state');
