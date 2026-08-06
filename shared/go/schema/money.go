package schema

// Denomination — what an amount is measured in. Mirrors money.ts.
//
// Prova has two different units and they must not be conflated: the settlement asset the wallet
// holds on Stellar (testnet: SRT), and the fiat currency a user actually paid at a licensed anchor
// (AED, USD, ...). Today only the first exists — testanchor.stellar.org is SDF's reference anchor
// and SRT has no bank behind it, so there is no fiat leg for the backend to report.
//
// This type is the shape the backend will report once a licensed anchor is integrated: its SEP-24
// transaction carries `amount_in_asset` (e.g. "iso4217:AED"), which maps to DenominationFiat with
// the code after the colon. Nothing populates it yet — see Docs/deposit-flow.md.

// DenominationKind is whether a denomination is an on-chain asset or a real-world currency.
type DenominationKind string

const (
	// DenominationAsset is a Stellar asset code — what the wallet holds. Has no country.
	DenominationAsset DenominationKind = "asset"
	// DenominationFiat is an ISO 4217 currency — real money someone actually paid.
	DenominationFiat DenominationKind = "fiat"
)

// Denomination is the unit an amount is measured in. Always carried alongside the amount.
type Denomination struct {
	// Code is a Stellar asset code ("SRT") or an ISO 4217 currency code ("AED").
	Code string           `json:"code"`
	Kind DenominationKind `json:"kind"`
	// Exponent is the number of decimal places. Note this is 2 for assets in the wallet's
	// spendable-balance view, not Stellar's native 7 — see the note in money.ts.
	Exponent int `json:"exponent"`
}
