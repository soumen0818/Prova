# Proving benchmarks

First real proofs generated from Prova's Compact circuits. Until this, the deciding metric for
Phase 1.2 was empty — the circuits had been compiled and (later) executed, but never proven.

Reproduce with:

```
docker run -d --rm -p 6300:6300 midnightnetwork/proof-server:7.0.0-rc.1 \
  -- 'midnight-proof-server --verbose'
npm run build
node bench/prove.mjs 3
```

## Host

| | |
|---|---|
| CPU | AMD Ryzen 5 7235HS, 8 cores |
| RAM | 23 GB |
| Proof server | `midnightnetwork/proof-server:7.0.0-rc.1`, in Docker, same machine |

Proving runs **on the server, not in-process** — the times below are round-trip over localhost
HTTP. Network cost is negligible here; on a phone this becomes either an on-device prover or a
call to a remote one, and that choice is the whole question (see below).

## Results

Steady-state, warm. Three iterations after discarding cold start.

| Circuit | What it proves | Avg | Range | Prover key | Proof |
|---|---|---:|---:|---:|---:|
| `proveEligibility` | KYC level + expiry | **864 ms** | 787–1007 | 2.7 MB | 4508 B |
| `transfer` | ownership, membership, nullifier, conservation, KYC | **5413 ms** | 5184–5802 | 18.6 MB | 4508 B |

Cold start is substantial: the first `transfer` proof of a fresh server took **14.6 s**, roughly
2.7× the warm figure, because the 18.6 MB proving key has to be loaded first. A later run against a
freshly started container produced a **28 s** first proof, so treat cold start as highly variable
and discard it — benchmark against a server that has already proven once, or the average is
meaningless.

Re-measured after the constructors were added (`requiredKycLevel` is now non-zero, so the KYC
branch genuinely runs rather than passing trivially): **5520 ms** transfer, **~820 ms**
eligibility. Unchanged within noise, as expected — a constructor runs once at deployment, not per
proof.

## What these numbers say

**The value layer costs ~6× the compliance layer.** `proveEligibility` checks two inequalities;
`transfer` adds a depth-10 Merkle path, three commitment hashes, a nullifier, and conservation.
That gap is the price of proving ownership of money rather than merely eligibility to move it.

**Proof size is constant at 4508 bytes** regardless of circuit complexity — expected for this proof
system, and the reason on-chain verification cost does not grow as the circuits do.

**5.4 s is a desktop number, and the mobile question is still open.** A Ryzen 5 with 8 cores and
23 GB of RAM is not a phone. Two things have to be measured before the direction is settled:

1. **On-device proving.** The honest expectation is several times slower — phone cores are weaker
   and thermally limited, and the 18.6 MB key has to be held in memory on a device where that is
   a real constraint. If that lands above ~30 s, on-device proving for transfers is not viable as
   a foreground user action, whatever else is true.
2. **Remote proving.** 5.4 s server-side plus round-trip is plausible as a product experience, but
   it means the witness — the spending key, the amount, the recipient — leaves the device. That
   defeats the point of the privacy layer unless the proof server is the user's own. This is a
   design decision, not a benchmark.

Phase 1.2's deciding metric is now partly filled: proving works, and the desktop cost is known.
The phone number is the remaining unknown, and it is the one that decides the architecture.

## Caveats

- Compiled with `compact` 0.5.2, language version 0.26.
- Proof server pinned to `7.0.0-rc.1`, digest
  `sha256:f5ca7be1890f9ccf5a4b344aec0bcc695332df525214ea4a11bc52b9990cb229`. It was originally run
  as `:latest`, which resolved to this same image — but `:latest` moves, and a benchmark quoted
  against a moving target means nothing.
- Single machine, single run of three. Enough to establish magnitude, not enough for a regression
  threshold.
- `transfer` is benchmarked at Merkle depth 10. A production tree would be deeper, and the path
  check scales with depth.
