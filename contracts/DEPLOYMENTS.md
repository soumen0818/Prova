# Prova — Contract Deployments

Tracked deployments of the `prova-verifier` contract per environment.

## Testnet — Phase 2 verifier (stateful state machine)

| Field | Value |
| --- | --- |
| Contract ID | `CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` (`GCBA5YVACDJ6MP46JNHHTMCNJD4I2NRRVEGLBAKQRYJTFBQP5BIWXZR7`) |
| Explorer | https://stellar.expert/explorer/testnet/contract/CAM5FO22PLIINNETME2CXFPS2WL7WCYOESYTLNYPQMWVKWDADWD4BTJC |
| Interface | `submit(proof, commitment, nullifier)` verifies + records + emits event; `verify(...)`, `is_spent(...)`, `is_committed(...)` |
| Verified (live testnet) | submit valid → Success + `transfer` event; `is_committed`/`is_spent` → true; replay → `Error #1 NullifierAlreadyUsed` |
| Verify cost | ~44.6M CPU / ~418KB mem (native); within the 100M cap |

Redeploy with `./scripts/deploy_testnet.sh` (requires a funded testnet identity named
`prova-test`, or set `STELLAR_IDENTITY`).

### Superseded

| Contract ID | Note |
| --- | --- |
| `CB7MT652LPAW5UUEQ4RWQ3CF3RM2Z3RZK7PLXMRWCRKRJB5A3Q23TOSC` | Phase 1 verify-only (no state). Replaced by the Phase 2 state machine above. |
| `CBMVF3EBBHL53QNYRZ5RXR2BJVGAWFJSSWFCJYJWKHP4X4VBJ6WJFZIK` | Phase 0 skeleton (no proof verification). |

## Mainnet

Not deployed (Phase 5).
