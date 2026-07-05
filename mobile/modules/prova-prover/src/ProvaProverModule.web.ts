// Proving is native-only; web (dev preview) has no prover.
const unavailable = async (): Promise<string> => {
  throw new Error('On-device prover is not available on web — run on Android.');
};
export default { prove: unavailable, userId: unavailable };
