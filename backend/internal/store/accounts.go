package store

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

// SeenAccount records a successful sign-in and reports whether this address had been seen before.
//
// The boolean is what lets the app tell a returning user from a new one after a reinstall, which is
// the difference between offering to restore a backup and silently starting a second wallet.
//
// Deliberately combined into one statement: a separate "does this exist?" call would be an
// enumeration oracle for anyone who could reach it. Here the answer is only ever produced as a
// side-effect of proving control of the inbox.
func (s *Store) SeenAccount(ctx context.Context, email string) (returning bool, err error) {
	// xmax is 0 for a freshly inserted row and non-zero when the row already existed and was
	// updated — the standard way to tell an upsert's two paths apart in one round trip.
	row := s.pool.QueryRow(ctx, `
INSERT INTO accounts (email) VALUES ($1)
ON CONFLICT (email) DO UPDATE SET last_seen_at = now()
RETURNING (xmax <> 0)`, email)

	if err := row.Scan(&returning); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return false, nil
		}
		return false, err
	}
	return returning, nil
}

// ErrWalletClaimed means the wallet is bound to a different account.
var ErrWalletClaimed = errors.New("wallet belongs to another account")

// ClaimWallet binds a wallet identifier to an account, or confirms it is already bound to it.
//
// Trust-on-first-use. The app cannot prove it holds the key behind `userID` — that would need the
// circuit to expose a signing operation — so the first account to present one claims it. What this
// does buy is the case that actually matters: once a wallet is in use, no other account can touch
// its verification, its credential, or its status.
//
// Idempotent, because it runs on every authenticated request that names a wallet.
func (s *Store) ClaimWallet(ctx context.Context, email, userID string) error {
	// The WHERE clause is what makes this safe under concurrency: the update only applies when the
	// row is unclaimed or already claimed by this same wallet, so two racing requests cannot both
	// win. A conflicting claim updates nothing and reports no rows.
	tag, err := s.pool.Exec(ctx, `
UPDATE accounts
   SET pool_user_id = $2
 WHERE email = $1
   AND (pool_user_id IS NULL OR pool_user_id = $2)`, email, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWalletClaimed
	}
	return nil
}

// WalletOf returns the wallet bound to an account, or "" when none has been claimed yet.
func (s *Store) WalletOf(ctx context.Context, email string) (string, error) {
	var id *string
	err := s.pool.QueryRow(ctx, `SELECT pool_user_id FROM accounts WHERE email = $1`, email).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if id == nil {
		return "", nil
	}
	return *id, nil
}
