// Generate a real ZK proof of the transfer circuit and time it.
//
// This is the number Phase 1.2 has been waiting on. Everything until now proved the circuits
// *execute*; this proves they can actually be proven, and says how long that takes.
//
// The flow: run the circuit to get a transcript (the same thing the tests produce), then hand that
// transcript plus the proving key to the proof server. `httpClientProvingProvider` owns the wire
// format — an earlier version of this script hand-rolled the request and was rejected by the server
// for a versioned header it does not document, which is a good reason to use the real client.
//
// Requires a proof server:
//   docker run -d --rm -p 6300:6300 midnightnetwork/proof-server:7.0.0-rc.1 \
//     -- 'midnight-proof-server --verbose'
//
// Usage: node bench/prove.mjs [iterations]

import {
  createConstructorContext,
  createCircuitContext,
  proofDataIntoSerializedPreimage,
} from '@midnight-ntwrk/compact-runtime';
import { httpClientProvingProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { ZKConfigProvider } from '@midnight-ntwrk/midnight-js-types';
import * as Transfer from '../build-transfer/contract/index.js';
import { readFile } from 'node:fs/promises';

const PROOF_SERVER = process.env.PROOF_SERVER ?? 'http://localhost:6300';
const ITERATIONS = Number(process.argv[2] ?? 3);
const COIN_PUBLIC_KEY = '0'.repeat(64);
const CONTRACT_ADDRESS = '00'.repeat(32);
const b32 = (n) => new Uint8Array(32).fill(n);

/** Serves the artifacts `compact compile` produced, straight off disk. */
class BuildDirZKConfig extends ZKConfigProvider {
  constructor(dir) {
    super();
    this.dir = dir;
  }
  getZKIR(id) { return readFile(`${this.dir}/zkir/${id}.bzkir`); }
  getProverKey(id) { return readFile(`${this.dir}/keys/${id}.prover`); }
  getVerifierKey(id) { return readFile(`${this.dir}/keys/${id}.verifier`); }
}

const sk = b32(7);
const rho = b32(9);
const ownerPk = Transfer.pureCircuits.tOwnerPk(sk);

let path = null;
const read = (v) => (ctx) => [ctx.privateState, v];
const contract = new Transfer.Contract({
  spenderSecretKey: read(sk),
  inputAmount: read(100n),
  inputRho: read(rho),
  output1Amount: read(60n),
  output1OwnerPk: read(b32(1)),
  output1Rho: read(b32(2)),
  output2Amount: read(40n),
  output2OwnerPk: read(ownerPk),
  output2Rho: read(b32(3)),
  kycLevel: read(3n),
  kycExpiry: read(2_000_000_000n),
  inputPath: (ctx) => [ctx.privateState, path],
});

const ctx = (id, state) =>
  createCircuitContext(id, CONTRACT_ADDRESS, COIN_PUBLIC_KEY, state, {});

// The corridor minimum the benchmarked contract is deployed with. Matches the tests and the deploy
// default; the witness credential below sits above it, so the KYC branch is exercised rather than
// short-circuited — proving cost should reflect the checks that actually run.
const REQUIRED_KYC = 1n;

// --- Set up a spendable note ---------------------------------------------------------------
const init = await contract.initialState(
  createConstructorContext({}, COIN_PUBLIC_KEY), REQUIRED_KYC);
const dep = await contract.impureCircuits.deposit(
  ctx('deposit', init.currentContractState), 100n, ownerPk, rho);
const state = dep.context.callContext.currentQueryContext.state;
path = Transfer.ledger(state).commitments.findPathForLeaf(dep.result);

const zkConfig = new BuildDirZKConfig('build-transfer');
const prover = httpClientProvingProvider(PROOF_SERVER, zkConfig);

/**
 * Run a circuit and serialize its transcript into a proof preimage.
 *
 * The provider takes the preimage, not the raw proof data — it adds the versioned header and
 * attaches the key material itself, which is the part that is easy to get wrong by hand.
 */
async function preimageFor(circuitId, run) {
  const res = await run();
  // Depth-first, root last: this circuit's call is the final entry.
  const call = res.context.callProofDataTrace.at(-1);
  return proofDataIntoSerializedPreimage(
    call.input,
    call.output,
    call.publicTranscript,
    call.privateTranscriptOutputs,
    circuitId,
  );
}

async function benchmark(label, circuitId, call) {
  const preimage = await preimageFor(circuitId, call);
  console.log(`  preimage: ${preimage.length} bytes`);

  const times = [];
  let proofBytes = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    const proof = await prover.prove(preimage, circuitId);
    times.push(performance.now() - t0);
    proofBytes = proof?.length ?? 0;
    console.log(`  run ${i + 1}: ${times.at(-1).toFixed(0)} ms`);
  }

  const avg = times.reduce((a, x) => a + x, 0) / times.length;
  console.log(`\n  ${label}`);
  console.log(`    avg ${avg.toFixed(0)} ms  (min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)})`);
  if (proofBytes) console.log(`    proof ${proofBytes} bytes`);
  return avg;
}

console.log(`Proof server: ${PROOF_SERVER}`);
console.log(`Iterations:   ${ITERATIONS}`);
console.log(`Host:         ${process.platform} ${process.arch}\n`);

console.log('transfer — 1 note in, 2 out, KYC check, merkle depth 10');
await benchmark('transfer', 'transfer', () =>
  contract.impureCircuits.transfer(ctx('transfer', state), 1_700_000_000n));

// The eligibility circuit, for contrast. It proves the KYC statement alone — no note, no merkle
// path, no conservation — so the gap between the two is the cost of the value layer, which is the
// part that would have to run on a phone.
console.log('\nproveEligibility — KYC only, no value');
const Compliance = await import('../build/contract/index.js');
const complianceZk = new BuildDirZKConfig('build');
const complianceProver = httpClientProvingProvider(PROOF_SERVER, complianceZk);

const cred = { userId: b32(11), kycLevel: 3n, expiry: 2_000_000_000n };
const compliance = new Compliance.Contract({
  credentialUserId: read(cred.userId),
  credentialKycLevel: read(cred.kycLevel),
  credentialExpiry: read(cred.expiry),
});
const cInit = await compliance.initialState(
  createConstructorContext({}, COIN_PUBLIC_KEY),
  Compliance.pureCircuits.policyCommitment(b32(77)),
  REQUIRED_KYC,
);
const cRes = await compliance.impureCircuits.proveEligibility(
  ctx('proveEligibility', cInit.currentContractState.data), 1_700_000_000n);
const cCall = cRes.context.callProofDataTrace.at(-1);
const cPre = proofDataIntoSerializedPreimage(
  cCall.input, cCall.output, cCall.publicTranscript, cCall.privateTranscriptOutputs, 'proveEligibility');
console.log(`  preimage: ${cPre.length} bytes`);

const cTimes = [];
let cBytes = 0;
for (let i = 0; i < ITERATIONS; i++) {
  const t0 = performance.now();
  const p = await complianceProver.prove(cPre, 'proveEligibility');
  cTimes.push(performance.now() - t0);
  cBytes = p?.length ?? 0;
  console.log(`  run ${i + 1}: ${cTimes.at(-1).toFixed(0)} ms`);
}
const cAvg = cTimes.reduce((a, x) => a + x, 0) / cTimes.length;
console.log(`\n  proveEligibility`);
console.log(`    avg ${cAvg.toFixed(0)} ms  (min ${Math.min(...cTimes).toFixed(0)}, max ${Math.max(...cTimes).toFixed(0)})`);
console.log(`    proof ${cBytes} bytes`);
