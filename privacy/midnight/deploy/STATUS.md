# Midnight Preprod deployment status

**Last verified: 2026-09-30.**

The earlier compiler/SDK incompatibility is resolved. Prova now uses this supported tuple:

- Compact compiler 0.31.1;
- Compact language 0.23.0;
- Compact runtime 0.16.0;
- Midnight JS SDK 4.1.1; and
- ledger 8.0.2 / proof server 8.0.3.

The compatibility guard in `scripts/check-toolchain.mjs` fails the build if those versions drift.

## Verified

- All 39 Compact simulator tests pass.
- The Preprod RPC responded; the v4 indexer responded earlier but returned HTTP 503 during the managed replacement sync on 2026-09-30.
- The local proof server responds and all required prover keys exist.
- Deployment constructor arguments are derived and validated.
- The deployer reads the new contract state back and verifies authority, issuer, KYC minimum,
  policy time, and an empty settlement replay set.
- The deployment wallet can synchronize against Preprod.

## On-chain deployment and current gate

The deployment address is:

```text
mn_addr_preprod1482lcxgr6ep3sj2pxkte2qhsph5yxt8zcxed5wrp97r4d7dwcqdse0c4la
```

The wallet received `5,000,000,000` Preprod tNIGHT, registered its NIGHT UTXO for DUST, and paid
for an initial deployment. Its public receipt is:

| Field | Value |
|---|---|
| Initial compliance address | `fc10b0068772ca70c2d1b47889ceb4d6507fd8a2d495dc499c681c9625283182` |
| Transaction hash | `2914ecb40db8633253bbc232a9129928e941b2980076226762ecca876a284b7b` |
| Block height | `2773238` |
| Block hash | `06ce3b03a6545df7bef3f6b6b5f6b226fb7e71cdc94db1759b8d0af93141863d` |

Its constructor state was read back and matched the requested authority, issuer, KYC minimum of
`1`, policy time, and empty replay set. **This is not the canonical submission address.** After the
transaction finalized, the SDK rejected its auto-generated maintenance key while saving local
private state. That key was not retained, so verifier or maintenance-authority updates cannot be
signed. The replacement deployer now supplies an explicit, backed-up maintenance key.

The managed replacement is syncing the DUST wallet. The official Preprod indexer returned HTTP
503 during that scan; the SDK is retrying. Do not submit the initial address as the managed MVP.

## Resume sequence

From `privacy/midnight`:

```bash
npm run deploy:check
npm run deploy
npm run deploy:verify
```

Do not start a second deploy while one is running. The first DUST synchronization can take over an
hour. After the replacement succeeds:

1. review `deployments/preprod.json`, which records the canonical address and transaction;
2. run the read-only public verifier above;
3. add the verified canonical address to the root README and submission form;
4. connect credential issuance and the eligibility call to the product flow; and
5. record the V2 demo only after the Midnight decision is visibly created and consumed.

`BLOCKED.md` is retained as the historical investigation that led to the compatible version tuple;
its original conclusion is no longer current.
