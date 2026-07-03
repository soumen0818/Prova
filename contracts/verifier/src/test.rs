#![cfg(test)]

use super::{Error, Verifier, VerifierClient};
use soroban_sdk::{BytesN, Env};

fn setup() -> (Env, VerifierClient<'static>) {
    let env = Env::default();
    let contract_id = env.register(Verifier, ());
    let client = VerifierClient::new(&env, &contract_id);
    (env, client)
}

#[test]
fn records_transfer_and_tracks_nullifier() {
    let (env, client) = setup();
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);

    assert!(!client.is_spent(&nullifier));
    client.submit(&commitment, &nullifier);
    assert!(client.is_spent(&nullifier));
}

#[test]
fn rejects_replayed_nullifier() {
    let (env, client) = setup();
    let commitment = BytesN::from_array(&env, &[1u8; 32]);
    let nullifier = BytesN::from_array(&env, &[2u8; 32]);

    client.submit(&commitment, &nullifier);
    let result = client.try_submit(&commitment, &nullifier);
    assert_eq!(result, Err(Ok(Error::NullifierAlreadyUsed)));
}
