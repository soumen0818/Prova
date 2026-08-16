package config

import "testing"

// The indexer lookback decides which existing notes a fresh deployment can see, and every way of
// getting it wrong is silent: the tree stays empty, /pool/path returns nothing, and wallets show a
// cached balance that cannot be spent. There is no error to notice, so the parsing is tested
// directly — particularly the cases that could turn a large window into a small one.
func TestIndexerLookbackParsing(t *testing.T) {
	const fallback = uint32(20_000)

	for _, tc := range []struct {
		name string
		set  bool
		env  string
		want uint32
	}{
		{"unset keeps the default", false, "", fallback},
		{"empty keeps the default", true, "", fallback},
		{"a plain value is used", true, "120000", 120_000},
		// Zero would mean "start at the chain head" and index nothing at all, so it is treated as
		// unset rather than obeyed.
		{"zero falls back", true, "0", fallback},
		{"negative falls back", true, "-5", fallback},
		{"non-numeric falls back", true, "lots", fallback},
		// The maximum retained window is ~120,000 ledgers, so a value this large is already
		// "everything available"; what matters is that it does not wrap to something tiny.
		{"uint32 max is accepted", true, "4294967295", 4_294_967_295},
		{"beyond uint32 falls back rather than wrapping", true, "4294967296", fallback},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("INDEXER_LOOKBACK_LEDGERS", tc.env)
			}
			if got := getu32("INDEXER_LOOKBACK_LEDGERS", fallback); got != tc.want {
				t.Errorf("getu32(%q) = %d, want %d", tc.env, got, tc.want)
			}
		})
	}
}

// Load must actually wire the variable through: the field existing and the environment being read
// are two different things, and a missing line in Load() would leave the default in place forever.
func TestLoadReadsIndexerLookback(t *testing.T) {
	t.Setenv("INDEXER_LOOKBACK_LEDGERS", "120000")
	if got := Load().IndexerLookback; got != 120_000 {
		t.Errorf("Load().IndexerLookback = %d, want 120000", got)
	}
}
