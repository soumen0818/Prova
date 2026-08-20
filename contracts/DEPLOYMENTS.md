# Prova — Contract Deployments

Tracked deployments of the `prova-verifier` and `prova-pool` contracts per environment.

## Testnet — Phase 4 shielded pool (XLM)

| Field | Value |
| --- | --- |
| Contract ID | `CBLLKIUUWPH4GCPL4NNK6S6NGDG4OEAX33TTYJ7RPO3SZU52FHYYJEVX` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` |
| Admin | `prova-admin` (`GBGSKDFXWQHKLNW6YE4AEOUW7WC35YOST4UCROPDDBEJEC3WAVVJFK7R`) |
| Token custodied | **native XLM** via SAC `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBLLKIUUWPH4GCPL4NNK6S6NGDG4OEAX33TTYJ7RPO3SZU52FHYYJEVX |
| Deploy tx | https://stellar.expert/explorer/testnet/tx/649c41b9fcece29afd8ee3af4a080d5580d4adef1c45339078b692cd158ad60a |
| Initialize tx | https://stellar.expert/explorer/testnet/tx/e84b49ec9da4f4514868e8607460453a5de7b8ecf85756026de9a229241bfb45 |
| Post-deploy checks | `is_paused` false ✓ · `queue_depth` 0 ✓ · `next_index` 0 ✓ |

**Why this replaced the pool below.** A backend cannot serve a pool whose tree it cannot reconstruct.
The previous pool had folded 2 leaves during development; when the EC2 deployment started with an
empty database it could not re-index them, because notes are learned from chain events and Soroban
RPC serves only a rolling ~7-day window. Every fold proof it built carried the empty-tree root, the
contract compared it against its real 2-leaf root and rejected it, and a real 5,000 XLM deposit sat
at "confirming" indefinitely.

Deploying a fresh pool makes the contract's tree and the backend's mirror agree at zero. The folder
now refuses loudly when they disagree rather than retrying forever — see `errTreeGap` in
`backend/internal/pool/folder.go`.

**When a pool is redeployed, the backend's pool tables must be truncated in the same change.** Left
in place, notes indexed from the old contract are folded into the new one's tree, and the mirror is
wrong from the first block.

## Testnet — Phase 4 shielded pool (XLM, superseded CBLLKI…)

Replaced because its tree could not be rebuilt from a fresh database — see the entry above.

| Field | Value |
| --- | --- |
| Contract ID | `CCOWLFXXKLFCBPES25273CX6VRQHG5S2OAXSOI4W7GR5KZZSW62K44ZX` |
| State when retired | `next_index` 2 · `queue_depth` 1 (one deposit permanently unfoldable) |

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
