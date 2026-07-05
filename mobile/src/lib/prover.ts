/**
 * On-device prover (Phase 4) — thin re-export of the local native module `prova-prover`.
 *
 * `prove` runs the arkworks Groth16 prover in Rust on a native thread (off the JS thread), so the
 * amount + secret never leave the device and the UI stays responsive. Requires a native dev build
 * (the module ships a `.so`); it is unavailable in web preview.
 */
export { prove, userId, isProverAvailable, type ProveInput } from '../../modules/prova-prover';
