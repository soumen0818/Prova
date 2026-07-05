/**
 * Soroban event schema the indexer reads — FROZEN for Phase 2.
 *
 * The verifier contract publishes one event per accepted transfer. Topic + data below match
 * `env.events().publish((symbol_short!("transfer"),), (commitment, nullifier))` in
 * `contracts/verifier`.
 */

import type { Hex } from './proof.js';

/** Event topic (Soroban symbol) for an accepted transfer. */
export const TRANSFER_EVENT_TOPIC = 'transfer';

/**
 * Data of a `transfer` event: the on-chain commitment and nullifier (both 32-byte hex). Leaks
 * nothing about the amount or identity. The indexer keys history off these.
 */
export interface TransferEvent {
  commitment: Hex;
  nullifier: Hex;
}
