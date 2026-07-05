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
