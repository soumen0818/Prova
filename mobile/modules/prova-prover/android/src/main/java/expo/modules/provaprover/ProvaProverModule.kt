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
  }

  private external fun nativeProve(input: String): String
  private external fun nativeUserId(secret: String): String

  companion object {
    init {
      System.loadLibrary("prova_prover")
    }
  }
}
