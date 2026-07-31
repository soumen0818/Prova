import ProvaProver from './src/ProvaProverModule';

/** Private inputs for one transfer proof. Amount + secret never leave the device. */
export interface ProveInput {
  amount: string; // decimal
  secret: string; // 32-byte hex
  transferId: string; // decimal
  kycLevel: string; // decimal
  expiry: string; // unix seconds
  currentTime: string; // unix seconds
  sigRx: string;
  sigRy: string;
  sigS: string;
  anchorPkX: string;
  anchorPkY: string;
}

/** True once the native prover is present (app rebuilt with the module). */
export const isProverAvailable = ProvaProver != null;

const REBUILD_MSG =
  'On-device prover not found. Rebuild the app with a native build (npx expo run:android).';

function unwrap(out: string): string {
  if (out.startsWith('error:')) throw new Error(out.slice(6));
  return out;
}

/** Generate a Groth16 proof on-device; resolves to the 544-byte Soroban proof blob (hex). */
export async function prove(input: ProveInput): Promise<string> {
  if (!ProvaProver) throw new Error(REBUILD_MSG);
  return unwrap(await ProvaProver.prove(JSON.stringify(input)));
}

/** Derive user_id = Poseidon(secret, domain) on-device (hex). */
export async function userId(secretHex: string): Promise<string> {
  if (!ProvaProver) throw new Error(REBUILD_MSG);
  return unwrap(await ProvaProver.userId(secretHex));
}

// ---------------------------------------------------------------------------
// Shielded pool (Phase 4) — Docs/shielded-pool.md
//
// Everything below runs natively for one of two reasons: it is Groth16 proving (impossible in JS at
// any usable speed), or it is Jubjub/Poseidon arithmetic that must match the circuit bit-for-bit. A
// second implementation in TypeScript would be a permanent chance to drift, and drift does not fail
// loudly — it makes notes unspendable or invisible.
//
// Secrets stay on the device: the seed goes in, proofs and opened notes come out.
// ---------------------------------------------------------------------------

/** A wallet's pool identity, derived from its master seed. */
export interface PoolKeys {
  /** Spending secret. Whoever holds this can move the notes. Never leaves the device. */
  owner_sk: string;
  /** The address notes are sent to. Shareable. */
  owner_pk: string;
  /** Note-encryption secret. Finds notes; cannot spend them. */
  enc_sk: string;
  /** Note-encryption public key (Jubjub). Shareable, and part of the address. */
  enc_pk_x: string;
  enc_pk_y: string;
}

/** One output note being created, addressed to its recipient. */
export interface PoolOutputNote {
  amount: number;
  owner_pk: string;
  rho: string;
  enc_pk_x: string;
  enc_pk_y: string;
}

export interface ShieldProveInput {
  amount: number;
  owner_pk: string;
  rho: string;
  enc_pk_x: string;
  enc_pk_y: string;
  /** Fresh random scalar. MUST differ per deposit — reuse repeats the one-time pad. */
  esk: string;
}

export interface ShieldProveOutput {
  /** `A(96) ‖ B(192) ‖ C(96)`, hex. */
  proof: string;
  commitment: string;
  epk_x: string;
  epk_y: string;
  enc_amount: string;
  enc_rho: string;
}

export interface SpendProveInput {
  in_amount: number;
  in_rho: string;
  owner_sk: string;
  /** Membership path, from `GET /pool/path/{commitment}`. */
  leaf_index: number;
  siblings: string[];
  root: string;
  out1: PoolOutputNote;
  out2: PoolOutputNote;
  /** Fresh random scalar per transfer. */
  esk: string;
  /** 0 for a private transfer; the amount leaving the pool for an unshield. */
  public_amount: number;
  /** Payout destination as a field element (the contract's `destination_field`); '' if private. */
  destination: string;
  kyc_level: number;
  expiry: number;
  sig_rx: string;
  sig_ry: string;
  sig_s: string;
  anchor_pk_x: string;
  anchor_pk_y: string;
  current_time: number;
}

export interface SpendProveOutput {
  proof: string;
  nullifier: string;
  out_c1: string;
  out_c2: string;
  epk_x: string;
  epk_y: string;
  enc1_amount: string;
  enc1_rho: string;
  enc2_amount: string;
  enc2_rho: string;
}

/** One note from the scan feed, to be trial-decrypted. */
export interface ScanCandidate {
  queue_index: number;
  commitment: string;
  epk_x: string;
  epk_y: string;
  enc_amount: string;
  enc_rho: string;
  /** Output slot (0 or 1) — folded into the decryption key, so it cannot be guessed. */
  slot: number;
}

/** A note that opened: it is ours, and we now know how to spend it. */
export interface FoundNote {
  queue_index: number;
  commitment: string;
  amount: number;
  rho: string;
  /** Nullifier this note will publish when spent; '' if no spending key was supplied. */
  nullifier: string;
}

function requireModule() {
  if (!ProvaProver) throw new Error(REBUILD_MSG);
  return ProvaProver;
}

/** Derive the wallet's pool keys from its master seed (hex). */
export async function poolKeys(seed: string): Promise<PoolKeys> {
  const out = unwrap(await requireModule().poolKeys(JSON.stringify({ seed })));
  return JSON.parse(out) as PoolKeys;
}

/** Prove a deposit's commitment binds its amount. ~0.2s. */
export async function poolShieldProve(input: ShieldProveInput): Promise<ShieldProveOutput> {
  const out = unwrap(await requireModule().poolShieldProve(JSON.stringify(input)));
  return JSON.parse(out) as ShieldProveOutput;
}

/** Prove a spend. The heaviest call the wallet makes — always show progress. */
export async function poolSpendProve(input: SpendProveInput): Promise<SpendProveOutput> {
  const out = unwrap(await requireModule().poolSpendProve(JSON.stringify(input)));
  return JSON.parse(out) as SpendProveOutput;
}

/**
 * Trial-decrypt a batch of notes; returns those belonging to this wallet.
 *
 * The feed is unfiltered on purpose — asking the server for "my notes" would tell it who is being
 * paid — so every note is tried and what opens is ours. Pass `ownerSk` to get each note's nullifier
 * back, which is what lets the wallet ask the backend whether it has already been spent.
 */
export async function poolScan(
  encSk: string,
  ownerPk: string,
  notes: ScanCandidate[],
  ownerSk?: string,
): Promise<FoundNote[]> {
  const out = unwrap(
    await requireModule().poolScan(
      JSON.stringify({ enc_sk: encSk, owner_pk: ownerPk, owner_sk: ownerSk ?? '', notes }),
    ),
  );
  return JSON.parse(out) as FoundNote[];
}

/**
 * Derive the proving keys ahead of time (~1s).
 *
 * Call once at app start, from a screen the user is not waiting on. Without it the cost lands inside
 * their first send, where it is very visible.
 */
export async function poolWarmUp(): Promise<void> {
  await requireModule().poolWarmUp();
}
