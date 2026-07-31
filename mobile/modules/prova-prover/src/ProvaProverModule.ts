import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class ProvaProverModule extends NativeModule {
  /** Generate a proof from a JSON input string; resolves to the hex proof blob (or `error:...`). */
  prove(input: string): Promise<string>;
  /** Derive `user_id = Poseidon(secret, domain)`; resolves to hex (or `error:...`). */
  userId(secret: string): Promise<string>;

  // --- Shielded pool (Phase 4). All take and return JSON strings. ---

  /** Derive the wallet's pool keys from its master seed. */
  poolKeys(input: string): Promise<string>;
  /** Prove a deposit's commitment binds its amount. */
  poolShieldProve(input: string): Promise<string>;
  /** Prove a spend: one note in, two out, value conserved, KYC valid. */
  poolSpendProve(input: string): Promise<string>;
  /** Trial-decrypt a batch of notes; returns those belonging to this wallet. */
  poolScan(input: string): Promise<string>;
  /** Derive the proving keys ahead of time (~1s). Call at app start. */
  poolWarmUp(): Promise<string>;
}

// Optional: returns null until the app is rebuilt with the native module (npx expo run:android).
export default requireOptionalNativeModule<ProvaProverModule>('ProvaProver');
