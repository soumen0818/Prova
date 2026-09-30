# Proving benchmarks

First real proofs generated from Prova's Compact circuits. Until this, the deciding metric for
Phase 1.2 was empty — the circuits had been compiled and (later) executed, but never proven.

Reproduce with:

```
docker run -d --rm -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.0.3
npm run build
node bench/prove.mjs 3
```

## Host

| | |
|---|---|
| CPU | AMD Ryzen 5 7235HS, 8 cores |
| RAM | 23 GB |
| Proof server | `midnightntwrk/proof-server:8.0.3`, in Docker, same machine |

Proving runs **on the server, not in-process** — the times below are round-trip over localhost
HTTP. Network cost is negligible here; on a phone this becomes either an on-device prover or a
call to a remote one, and that choice is the whole question (see below).

## Results

Steady-state, warm. Three iterations after discarding cold start.

| Circuit | What it proves | Avg | Range | Prover key | Proof |
|---|---|---:|---:|---:|---:|
| `proveEligibility` | issuer signature, holder binding, KYC, expiry, replay | **1848 ms** | 1746–1979 | 5.5 MB | 4860 B |
| `transfer` | ownership, membership, nullifier, conservation, KYC | **6117 ms** | 5999–6178 | 18.6 MB | 4508 B |

Cold start is substantial: the first current-toolchain `transfer` proof after starting the server
took **21.9 s**, versus **6.1 s** warm. Key loading and initialization make one cold observation too
variable for a threshold, so the table uses three warm runs.

These measurements supersede the earlier unsigned-credential benchmark. The current
`proveEligibility` circuit verifies the issuer's Schnorr signature, binds the credential to its
holder, checks policy, and records the one-time Stellar settlement decision.

## What these numbers say

**The experimental value circuit costs ~3.3× the authenticated compliance circuit.** Transfer adds
a depth-10 Merkle path, commitments, a nullifier, and conservation. This is not an apples-to-apples
product comparison: the transfer contract still has its older raw KYC witnesses and is deliberately
not deployed; the signed compliance contract is the Midnight V2 submission path.

**Proof size is circuit-dependent in this stack:** 4508 bytes for transfer and 4860 bytes for
authenticated eligibility. Do not assume proof size is constant across different circuits.

**6.1 s is a desktop number, and the mobile question is still open.** A Ryzen 5 with 8 cores and
23 GB of RAM is not a phone. Two things have to be measured before the direction is settled:

1. **On-device proving.** The honest expectation is several times slower — phone cores are weaker
   and thermally limited, and the 18.6 MB key has to be held in memory on a device where that is
   a real constraint. If that lands above ~30 s, on-device proving for transfers is not viable as
   a foreground user action, whatever else is true.
2. **Remote proving.** 6.1 s server-side plus round-trip is plausible as a product experience, but
   it means the witness — the spending key, the amount, the recipient — leaves the device. That
   defeats the point of the privacy layer unless the proof server is the user's own. This is a
   design decision, not a benchmark.

Phase 1.2's deciding metric is now partly filled: proving works, and the desktop cost is known.
The phone number is the remaining unknown, and it is the one that decides the architecture.

## Caveats

- Compact compiler 0.31.1, language 0.23.0, runtime 0.16.0, ledger 8.0.2.
- Proof server `8.0.3`, digest `sha256:8e6c36c3c175ef6e1b337952155b30470f252af79a20c3f65153a86a983e17ab`.
- Measured under Node 26.8.2; Node 22 is the supported app/CI version, so rerun there before treating
  these times as a regression threshold.
- Single machine, single run of three. Enough to establish magnitude, not enough for a regression
  threshold.
- `transfer` is benchmarked at Merkle depth 10. A production tree would be deeper, and the path
  check scales with depth.
