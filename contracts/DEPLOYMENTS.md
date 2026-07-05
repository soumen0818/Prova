# Prova — Contract Deployments

Tracked deployments of the `prova-verifier` contract per environment.

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
