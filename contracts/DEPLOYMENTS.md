# Prova — Contract Deployments

Tracked deployments of the `prova-verifier` contract per environment.

## Testnet — Phase 1 verifier (BLS12-381 Groth16)

| Field | Value |
| --- | --- |
| Contract ID | `CB7MT652LPAW5UUEQ4RWQ3CF3RM2Z3RZK7PLXMRWCRKRJB5A3Q23TOSC` |
| Network | `Test SDF Network ; September 2015` |
| Deployer | `prova-test` (`GCBA5YVACDJ6MP46JNHHTMCNJD4I2NRRVEGLBAKQRYJTFBQP5BIWXZR7`) |
| Explorer | https://stellar.expert/explorer/testnet/contract/CB7MT652LPAW5UUEQ4RWQ3CF3RM2Z3RZK7PLXMRWCRKRJB5A3Q23TOSC |
| Verified | valid proof → `true`, tampered proof → `false` (live testnet `verify` invoke) |
| Verify cost | ~44.6M CPU instructions, ~418KB mem (native estimate); within Soroban's 100M cap — testnet simulation passed |

Redeploy with `./scripts/deploy_testnet.sh` (requires a funded testnet identity named
`prova-test`, or set `STELLAR_IDENTITY`).

### Phase 0 skeleton (superseded)

| Field | Value |
| --- | --- |
| Contract ID | `CBMVF3EBBHL53QNYRZ5RXR2BJVGAWFJSSWFCJYJWKHP4X4VBJ6WJFZIK` |
| Note | Phase 0 nullifier/commitment skeleton, no proof verification. Replaced by the Phase 1 verifier above. |

## Mainnet

Not deployed (Phase 5).
