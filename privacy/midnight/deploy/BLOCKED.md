# Deployment: blocked on a toolchain version split

**Status as of 2026-09-26.** Everything up to the contract-deployment call works and is proven on
chain. The final call fails because no published combination of compiler, runtime and `midnight-js`
agrees with the others.

This file records what was tested so the next attempt starts from evidence rather than repeating it.

## What works, verified on Preview

| | Evidence |
|---|---|
| Headless wallet, correct network | `mn_addr_preview1482lcxgr6ep3sj2pxkte2qhsph5yxt8zcxed5wrp97r4d7dwcqdsewx9vq` |
| Faucet funding | 5,000,000,000 tNIGHT visible to the wallet |
| Wallet sync | shielded + unshielded + dust all `isStrictlyComplete()`, ~11 min first run |
| Dust registration | on-chain tx `002cb454c8a8095eaceb…`, signed by the headless wallet |
| Dust generation | 126,774,444,999,999,999 — far more than two deployments need |
| Preflight | node, indexer, proof server, prover keys — all green |

The wallet, the signing path, the funding path and the network config are all correct. What follows
is the only thing left.

## The split

`deployContract` calls the generated contract's `initialState`. Whether that call works depends on
three versions agreeing, and they do not:

| Compiler | Language version | Generated `initialState` | Needs runtime |
|---|---|---|---|
| 0.24.0 | 0.16 | **synchronous** | **0.8.1** |
| 0.26.0 | 0.18 | — | — |
| 0.28.0 | 0.20 | — | — |
| 0.34.0 (in use) | 0.26 | **async** | **0.19.0** |

| `midnight-js` line | Bundled `compact-js` | Calls `initialState` |
|---|---|---|
| 4.1.1 (stable) | 2.5.1 → runtime 0.16.0 | **synchronously** |
| 5.0.0-beta.8 | 2.5.5-rc.8 → runtime 0.19.0-rc.0 | **awaited** |

Our contracts are written for language version 0.26, which only compiler 0.34.0 accepts, which emits
an `async initialState` for runtime 0.19.0 — and stable `midnight-js` 4.1.1 destructures that call's
result synchronously, getting `undefined` for every field.

## Every combination tested

1. **Compiler 0.34.0 + `midnight-js` 4.1.1 (stable).**
   `TypeError: Cannot read properties of undefined (reading 'coinPublicKey')` — a Promise
   destructured as if it were a value.

2. **Compiler 0.34.0 + `compact-js` 3.0.0-rc.0 (hoisted only).**
   The upgraded copy awaits correctly, but `midnight-js-contracts` reaches `compact-js` through
   `midnight-js-protocol`'s own nested 2.5.1, which sees a foreign object:
   `TypeError: Cannot read properties of undefined (reading 'ctor')`.

3. **Compiler 0.34.0 + the whole `midnight-js` stack on 5.0.0-beta.8.**
   Resolves the `compact-js` split — and breaks the wallet instead. `wallet-sdk` and the beta
   `midnight-js-protocol` no longer share a ledger version, so the keys are rejected by `ledger-v8`:
   `Error: expected instance of ZswapSecretKeys`, `expected instance of DustSecretKey`, repeating
   as `Wallet.Other: Error while applying sync update`. This is strictly worse than (1): the wallet
   had been working.

4. **Contracts lowered to `pragma language_version 0.16`, compiled with 0.24.0.**
   All three contracts compile **unchanged** apart from the pragma line — no feature in them needs
   0.26 — and the output has the synchronous `initialState` stable `midnight-js` wants. But that
   compiler targets `compact-runtime` **0.8.1**, not 0.16.0:
   `CompactError: Version mismatch: compiled code expects 0.8.1, runtime is 0.19.0`.
   Following it would mean downgrading the runtime eight minor versions and every package that
   depends on it.

That the contracts compile cleanly at language version 0.16 is worth keeping: **the source is not
the obstacle.** Only the toolchain pairing is.

## What to try next

1. **Ask Midnight directly** — Discord or a GitHub issue on `midnight-docs`. The question is one
   line: *which `compact` compiler version pairs with `midnight-js` 4.1.1?* That single answer
   resolves this, and it is not something to keep guessing at.
2. **Find the compiler that targets `compact-runtime` 0.16.0.** It sits between 0.24.0 (runtime
   0.8.1) and 0.34.0 (runtime 0.19.0); versions 0.26.0/0.28.0/0.29.0/0.30.0/0.31.x are untested for
   runtime target, only for language version. If one emits 0.16.0 *and* accepts a language version
   our contracts can be lowered to, that is the fix.
3. **Watch for `midnight-js` 5.0.0 stable.** It will pair with a `wallet-sdk` built against the same
   ledger, which is exactly what attempt (3) lacked.

## Reproducing

```
npm run wallet:new       # generate a deployment wallet, print the address to fund
npm run deploy:check     # preflight only — passes today
npm run deploy           # fails at deployContract, as above
```

The wallet in `.env` is already funded and its dust already registered, so a retry skips straight to
the failing call.
