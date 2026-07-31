package expo.modules.provaprover

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Prova on-device prover (Phase 4). Bridges to the Rust arkworks prover in `libprova_prover.so`.
 *
 * `prove`/`userId` are AsyncFunctions, so Expo runs them off the JS thread — proving (heavy) never
 * blocks the UI. The amount and secret stay on-device; the JNI functions live in the Rust crate
 * (`jni_bridge.rs`), delegating to `ffi::prove_json` / `ffi::user_id_hex`.
 */
class ProvaProverModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ProvaProver")

    AsyncFunction("prove") { input: String ->
      nativeProve(input)
    }

    AsyncFunction("userId") { secret: String ->
      nativeUserId(secret)
    }

    // --- Shielded pool (Phase 4) ---
    //
    // All async, so proving (hundreds of ms) and scanning never block the UI thread. Secrets go in
    // and stay in: the seed, the spending key and the note contents never leave the device.

    AsyncFunction("poolKeys") { input: String ->
      nativePoolKeys(input)
    }

    AsyncFunction("poolShieldProve") { input: String ->
      nativePoolShieldProve(input)
    }

    AsyncFunction("poolSpendProve") { input: String ->
      nativePoolSpendProve(input)
    }

    AsyncFunction("poolScan") { input: String ->
      nativePoolScan(input)
    }

    // Derives the proving keys (~1s) so a user's first send doesn't pay for it. Fire at app start.
    AsyncFunction("poolWarmUp") {
      nativePoolWarmUp("")
    }
  }

  private external fun nativeProve(input: String): String
  private external fun nativeUserId(secret: String): String
  private external fun nativePoolKeys(input: String): String
  private external fun nativePoolShieldProve(input: String): String
  private external fun nativePoolSpendProve(input: String): String
  private external fun nativePoolScan(input: String): String
  private external fun nativePoolWarmUp(input: String): String

  companion object {
    init {
      System.loadLibrary("prova_prover")
    }
  }
}
