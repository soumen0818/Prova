# Prova — Contract Deployments

Tracked deployments of the `prova-verifier` and `prova-pool` contracts per environment.

## Testnet — Phase 4 shielded pool (XLM)

| Field | Value |
| --- | --- |
| Contract ID | `CCOWLFXXKLFCBPES25273CX6VRQHG5S2OAXSOI4W7GR5KZZSW62K44ZX` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` |
| Admin | `prova-admin` (`GBGSKDFXWQHKLNW6YE4AEOUW7WC35YOST4UCROPDDBEJEC3WAVVJFK7R`) |
| Token custodied | **native XLM** via SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CCOWLFXXKLFCBPES25273CX6VRQHG5S2OAXSOI4W7GR5KZZSW62K44ZX |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/f42daa1bcf1265f82a4452de53bd2313f8519fe40d83315f4f7505c18c04436a |
| Initialize tx | https://stellar.expert/explorer/testnet/tx/159b5de89e35f041b7e359bae7e0efa4cae854c7cd52c6768f2e1283780847ed |
| Post-deploy checks | `admin` ✓ · `is_paused` false ✓ · `queue_depth` 0 ✓ · `next_index` 0 ✓ |

**Why XLM and not SRT.** The earlier pool custodied SRT, and SRT turned out to be unobtainable on
testnet: SDF's anchor accepts SEP-12 customer info (status `ACCEPTED`, no outstanding fields) but
never delivers the asset — a deposit represents a fiat transfer that never arrives in a sandbox —
its SEP-24 web UI is an unfinished demo whose landing route is placeholder text, and the DEX has
**zero SRT sellers**. With no route to the asset, the shield/spend flow could not be exercised at
all. XLM has a faucet that always works, needs no trustline, and removes the anchor from the demo
path — which is honest, since a working anchor leg needs a licensed partner (Phase 5).

## Testnet — Phase 4 shielded pool (SRT, superseded)

| Field | Value |
| --- | --- |
| Contract ID | `CCIKEXCOFG4PLRQEG4OD3QG76LGEWO6RZFX6WGBPRWEZZQ2SJ5UMJ2G5` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` |
| Admin | `prova-admin` (`GBGSKDFXWQHKLNW6YE4AEOUW7WC35YOST4UCROPDDBEJEC3WAVVJFK7R`) — secret held offline only, see `Docs/deployment-and-keys.md` §1 |
| Token custodied | SRT (`GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B`) via SAC `CBZVLMD5DBKIFSVU23WAVMJD25IRUBWCVAXGURPUPMB2CUNFBQN742UV` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CCIKEXCOFG4PLRQEG4OD3QG76LGEWO6RZFX6WGBPRWEZZQ2SJ5UMJ2G5 |
| Wasm hash | `51b2879d13850ae1146ceff3ff9bbef4bd674d502b27d2d33a29192940b42469` |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/a5f6955b90097e21909227506e7e9cfee18d326645f19d56a243abd30cc32c7c |
| Initialize tx | https://stellar.expert/explorer/testnet/tx/04f70000ca58bc1e0946a48f2725e7a07cd5904a29edc851b306c011a454a6d9 |
| Anchor KYC key | `x=17ba7d68b3cb66509eed2e0a48a35ab88a18e7dbfcd9c43b245a6e6ced25213d` `y=3391696cfedf0d55bba5522f1e3cb670f26de6ef665fbd2711714810eafb0be1` |
| Post-deploy checks | `admin` == prova-admin's address ✓ · `root` == `673c8a95…` (matches the circuit's independently-computed empty-tree root) ✓ · `is_paused` == false ✓ · `queue_depth` == 0 ✓ |

Redeploy with `TOKEN_ID=<SAC address> ./scripts/deploy_pool_testnet.sh` — requires funded
`prova-admin` and `prova-test` identities. `initialize` is one-shot; a wrong admin address means
redeploying under a new contract ID, since it cannot be changed after the fact.

Set `backend/.env`: `POOL_CONTRACT_ID=CCIKEXCOFG4PLRQEG4OD3QG76LGEWO6RZFX6WGBPRWEZZQ2SJ5UMJ2G5`.

### Anchor key rotation — 2026-07-31

Rotated off the prover's built-in dev key to a dedicated `ANCHOR_SEED` via `set_anchor`
(admin-only, `prova-admin`). This invalidated every credential issued under the old dev key —
a non-issue on testnet with no real users yet.

| Field | Value |
| --- | --- |
| Anchor public key | `x=27262bd204b7923acf21919c0d2b29be871a2f989d21c1d394b0d881a0df3e5b` `y=063d8d9ae872afd059e191873ad07d364ca751071178809e857ee0eef7c33cbb` |
| `set_anchor` tx | https://stellar.expert/explorer/testnet/tx/f31dd06f400f744d74e8f7b4cff37b42f8f13a7e5e11beeed1e6345792421560 |
| Verified | On-chain event bytes match the key derived from `prova-prover anchor-pubkey` ✓ |

The corresponding `ANCHOR_SEED` lives only in `backend/.env` on the machine that issues KYC
credentials — never committed, never documented here.

## Testnet — Phase 3 verifier (KYC-inclusive)

| Field | Value |
| --- | --- |
| Contract ID | `CBQ2HVIYASMYNRIKWM54JUA3A4OGQOWRP42BLMRRB262YQINAA36GD5U` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` (`GCBA5YVACDJ6MP46JNHHTMCNJD4I2NRRVEGLBAKQRYJTFBQP5BIWXZR7`) |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBQ2HVIYASMYNRIKWM54JUA3A4OGQOWRP42BLMRRB262YQINAA36GD5U |
| Circuit | v2: range + commitment + nullifier + **in-circuit anchor KYC signature** (Jubjub EdDSA) + expiry + level |
| Public inputs | `[commitment, nullifier, anchorPk.x, anchorPk.y, currentTime]` (VK has 6 IC points) |
| Interface | `submit(proof, commitment, nullifier, pkx, pky, time)`; `verify(...)`, `is_spent`, `is_committed` |
| Verified (live testnet) | KYC proof → `verify` true, `submit` Success + `transfer` event |
| Verify cost | ~49.0M CPU / ~427KB mem (native); within the 100M cap (in-circuit KYC adds to *proving*, not verify) |

Redeploy with `./scripts/deploy_testnet.sh` (requires a funded testnet identity named
`prova-test`, or set `STELLAR_IDENTITY`).

### Superseded

| Contract ID | Note |
| --- | --- |
| `CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC` | Phase 2 stateful, pre-KYC (5 fewer public inputs). |
| `CB7MT652LPAW5UUEQ4RWQ3CF3RM2Z3RZK7PLXMRWCRKRJB5A3Q23TOSC` | Phase 1 verify-only (no state). |
| `CBMVF3EBBHL53QNYRZ5RXR2BJVGAWFJSSWFCJYJWKHP4X4VBJ6WJFZIK` | Phase 0 skeleton (no proof verification). |

## Mainnet

Not deployed (Phase 5).
