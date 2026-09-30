# Midnight network endpoints — verified 2026-09-30

All checked live from this machine on the date above. Prova's submission target is **Preprod**;
Preview remains available only for explicit development commands.

## Preprod (submission target)

| Service | Endpoint | Verified |
|---|---|---|
| Node RPC | `https://rpc.preprod.midnight.network` | `system_chain` → `"Midnight Preprod"` |
| Node WS | `wss://rpc.preprod.midnight.network` | wallet subscription connected |
| Indexer | `https://indexer.preprod.midnight.network/api/v4/graphql` | block query returned |
| Indexer WS | `wss://indexer.preprod.midnight.network/api/v4/graphql/ws` | wallet synchronized |
| Faucet | `https://midnight-tmnight-preprod.nethermind.dev/` | HTTP 200 |
| Proof server | `http://localhost:6300` | local 8.0.3 container responded |

`npm run deploy:check` verifies the RPC, indexer, local proof server, and all required prover keys
without creating a wallet transaction.

## Preview (optional development network)

| Service | Endpoint | Verified |
|---|---|---|
| Node RPC | `https://rpc.preview.midnight.network` | `system_chain` → `"Midnight Preview"` |
| Node WS | `wss://rpc.preview.midnight.network` | WebSocket handshake accepted |
| Indexer | `https://indexer.preview.midnight.network/api/v4/graphql` | returned block 1031282 |
| Indexer WS | `wss://indexer.preview.midnight.network/api/v4/graphql/ws` | not exercised |
| Faucet | `https://midnight-tmnight-preview.nethermind.dev/` | HTTP 200, rate limited |
| Proof server | `http://localhost:6300` | **always local** — see below |

Chain health at time of check: 12 peers, `isSyncing: false`.

Note the indexer path is **`/api/v4/graphql`**. `/api/v1/graphql` does not work.

**The wallet needs the `wss://` node URL, not the `https://` one.** It follows blocks by
subscription, which is WebSocket only. Given the https URL it retries `Timed out trying to connect`
indefinitely while every preflight check still passes — those are plain POSTs and work fine over
https. The two URLs are tracked separately in `deploy/new-wallet.mjs` (`node` vs `nodeWS`),
and the sync wait is bounded so this failure announces itself instead of hanging.

The indexer WebSocket requires the `graphql-transport-ws` subprotocol; a handshake without it is
rejected with HTTP 400, which looks like an outage and is not one.

## The proof server is always local

This is a design property of Midnight, not a deployment detail: the proof server takes the witness
— spending key, amounts, recipients — so it runs on the user's own machine. There is no hosted
proof server to point at, and pointing at someone else's would hand them exactly what the privacy
layer exists to protect.

That is also why `bench/RESULTS.md` treats "prove on device vs. prove on a server" as an open
architectural question rather than a performance tradeoff. The answer is not free.

```
docker run -d --rm -p 127.0.0.1:6300:6300 midnightntwrk/proof-server:8.0.3
```

First boot downloads public parameters (~1 minute) and does not persist them across `--rm`
containers, so a fresh container re-fetches. Drop `--rm` and reuse the container to avoid that.

## What deployment still needs

Network access, wallet derivation, DUST registration logic, prover keys, and constructor validation are
verified. The generated Preprod wallet currently reports `0 NIGHT`.

Fund the public address recorded in [`deploy/STATUS.md`](../deploy/STATUS.md), then run
`npm run wallet:status` followed by `npm run deploy`. The deployer registers eligible NIGHT UTXOs
for DUST through the wallet SDK, waits for DUST, deploys, and verifies the resulting public state.
