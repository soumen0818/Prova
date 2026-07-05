import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class ProvaProverModule extends NativeModule {
  /** Generate a proof from a JSON input string; resolves to the hex proof blob (or `error:...`). */
  prove(input: string): Promise<string>;
  /** Derive `user_id = Poseidon(secret, domain)`; resolves to hex (or `error:...`). */
  userId(secret: string): Promise<string>;
}

// Optional: returns null until the app is rebuilt with the native module (npx expo run:android).
export default requireOptionalNativeModule<ProvaProverModule>('ProvaProver');
