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
