//! JNI bridge for the Android native module (Phase 4). Only compiled for Android; delegates to the
//! shared `ffi::prove_json` / `ffi::user_id_hex`. The Kotlin `ProvaProverModule` declares matching
//! `external fun nativeProve/nativeUserId` and loads `libprova_prover.so`.

use jni::objects::{JClass, JString};
use jni::sys::jstring;
use jni::JNIEnv;

use crate::ffi;

fn run(mut env: JNIEnv, input: JString, f: fn(&str) -> Result<String, String>) -> jstring {
    let input: String = match env.get_string(&input) {
        Ok(s) => s.into(),
        Err(_) => return env.new_string("error:bad input").unwrap().into_raw(),
    };
    let out = f(&input).unwrap_or_else(|e| format!("error:{e}"));
    env.new_string(out).unwrap().into_raw()
}

/// `expo.modules.provaprover.ProvaProverModule.nativeProve(String): String`
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativeProve(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, ffi::prove_json)
}

/// `expo.modules.provaprover.ProvaProverModule.nativeUserId(String): String`
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativeUserId(
    env: JNIEnv,
    _class: JClass,
    secret: JString,
) -> jstring {
    run(env, secret, ffi::user_id_hex)
}

// --- Shielded pool (Phase 4) ---
//
// Each mirrors an `external fun` on the Kotlin module. All are AsyncFunctions there, so Expo runs
// them off the JS thread — proving takes hundreds of milliseconds and must never block the UI.

/// `nativePoolKeys(String): String` — derive the wallet's pool keys from its master seed.
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativePoolKeys(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, crate::pool::ffi::keys_json)
}

/// `nativePoolShieldProve(String): String` — prove a deposit's commitment binds its amount.
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativePoolShieldProve(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, crate::pool::ffi::shield_prove_json)
}

/// `nativePoolSpendProve(String): String` — the private-transfer proof. The heaviest call.
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativePoolSpendProve(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, crate::pool::ffi::spend_prove_json)
}

/// `nativePoolScan(String): String` — trial-decrypt a batch of notes; returns those that opened.
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativePoolScan(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, crate::pool::ffi::scan_json)
}

/// `nativePoolWarmUp(String): String` — derive the proving keys ahead of time.
///
/// Costs ~1 s. Called on a background thread at app start so a user's first send does not pay for
/// it; the argument is ignored.
#[no_mangle]
pub extern "system" fn Java_expo_modules_provaprover_ProvaProverModule_nativePoolWarmUp(
    env: JNIEnv,
    _class: JClass,
    input: JString,
) -> jstring {
    run(env, input, |_| crate::pool::ffi::warm_up())
}
