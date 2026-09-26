# Midnight network endpoints — verified 2026-09-26

All checked live from this machine on the date above. Recorded because the endpoints I had from
memory (`testnet-02`) are **retired and no longer resolve** — that network was replaced by
`preview`, and guessing at hostnames cost a detour worth not repeating.

## Preview (the current public test network)

| Service | Endpoint | Verified |
|---|---|---|
| Node RPC | `https://rpc.preview.midnight.network` | `system_chain` → `"Midnight Preview"` |
| Node WS | `wss://rpc.preview.midnight.network` | not exercised |
| Indexer | `https://indexer.preview.midnight.network/api/v4/graphql` | returned block 1031282 |
| Indexer WS | `wss://indexer.preview.midnight.network/api/v4/graphql/ws` | not exercised |
| Faucet | `https://midnight-tmnight-preview.nethermind.dev/` | HTTP 200, rate limited |
| Proof server | `http://localhost:6300` | **always local** — see below |

Chain health at time of check: 12 peers, `isSyncing: false`.

Note the indexer path is **`/api/v4/graphql`**. `/api/v1/graphql` does not work.

## The proof server is always local

This is a design property of Midnight, not a deployment detail: the proof server takes the witness
— spending key, amounts, recipients — so it runs on the user's own machine. There is no hosted
proof server to point at, and pointing at someone else's would hand them exactly what the privacy
layer exists to protect.

That is also why `bench/RESULTS.md` treats "prove on device vs. prove on a server" as an open
architectural question rather than a performance tradeoff. The answer is not free.

```
docker run -d --rm -p 6300:6300 midnightnetwork/proof-server:latest \
  -- 'midnight-proof-server --verbose'
```

First boot downloads public parameters (~1 minute) and does not persist them across `--rm`
containers, so a fresh container re-fetches. Drop `--rm` and reuse the container to avoid that.

## What deployment still needs

Network access is **not** the blocker it was assumed to be — all four services above are reachable.
What is still required:

1. A wallet with a funded address. The faucet dispenses tNIGHT, which is then registered for tDUST
   generation in the wallet; tDUST is what pays fees.
2. That registration step goes through Lace or the wallet SDK, and is the part that needs a human
   decision about key custody — not something to do unilaterally with a key that will later hold
   value.

Everything up to that point is verified working.
