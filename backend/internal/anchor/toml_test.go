package anchor

import "testing"

// The anchor's stellar.toml is written by someone else and its casing is not ours to control.
// SEP-1 shows upper-case keys in its examples; SDF's own testanchor uses lower case. Parsing only
// one of those made every asset lookup fail with "not found in anchor toml" while the asset was
// plainly present, which surfaced to users as a dead "Add funds" button.
func TestTomlKVIsCaseInsensitive(t *testing.T) {
	const doc = `
WEB_AUTH_ENDPOINT = "https://example.test/auth"

[[CURRENCIES]]
code = "SRT"
issuer = "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B"
status = "test"

[[CURRENCIES]]
CODE = "USDC"
ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
`

	for _, tc := range []struct {
		name, code, want string
	}{
		{"lower-case keys", "SRT", "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B"},
		{"upper-case keys", "USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := issuerFromToml(doc, tc.code)
			if got != tc.want {
				t.Fatalf("issuer for %s = %q, want %q", tc.code, got, tc.want)
			}
		})
	}

	if got := issuerFromToml(doc, "NOPE"); got != "" {
		t.Fatalf("unknown asset should resolve to empty, got %q", got)
	}
}
