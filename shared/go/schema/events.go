package schema

// Soroban event schema the indexer reads — FROZEN for Phase 2. Mirrors events.ts.
//
// The verifier contract publishes one event per accepted transfer:
//   env.events().publish((symbol_short!("transfer"),), (commitment, nullifier))

// TransferEventTopic is the Soroban event topic (symbol) for an accepted transfer.
const TransferEventTopic = "transfer"

// TransferEvent is the data of a `transfer` event: the on-chain commitment and nullifier (both
// 32-byte hex). Leaks nothing about the amount or identity. The indexer keys history off these.
type TransferEvent struct {
	Commitment Hex `json:"commitment"`
	Nullifier  Hex `json:"nullifier"`
}
