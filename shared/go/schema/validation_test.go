package schema

import "testing"

// These cases are mirrored EXACTLY in shared/src/validation.test.ts. Both suites must agree: the
// whole point of putting the rules in `shared` is that the app and the API cannot drift apart, and
// a divergence should surface here rather than as a user who can sign up on one path but not the
// other.

func TestIsValidEmail(t *testing.T) {
	valid := []string{
		"user@example.com",
		"first.last@example.co.uk",
		"user+tag@gmail.com",
		"u@ex.io",
		"UPPER@EXAMPLE.COM",
		"a_b-c@sub.domain.org",
	}
	for _, e := range valid {
		if !IsValidEmail(e) {
			t.Errorf("%q should be valid", e)
		}
	}

	invalid := []string{
		"",
		"  ",
		"plainaddress",
		"@example.com",       // no local part
		"user@",              // no domain
		"user@example",       // no TLD
		"user@example.c",     // TLD too short
		"user@.com",          // leading dot in domain
		"user@example..com",  // consecutive dots
		".user@example.com",  // leading dot in local
		"user.@example.com",  // trailing dot in local
		"us..er@example.com", // consecutive dots in local
		"user@-example.com",  // domain starts with a hyphen
		"user@example.com-",  // domain ends with a hyphen
		"user name@example.com",
		"user@exam ple.com",
		"user@example.123", // numeric TLD
	}
	for _, e := range invalid {
		if IsValidEmail(e) {
			t.Errorf("%q should be rejected", e)
		}
	}

	// Length caps.
	long := make([]byte, EmailLocalMax+1)
	for i := range long {
		long[i] = 'a'
	}
	if IsValidEmail(string(long) + "@example.com") {
		t.Error("a local part over 64 chars must be rejected")
	}
}

func TestNormalizeEmail(t *testing.T) {
	if got := NormalizeEmail("  User@Example.COM "); got != "user@example.com" {
		t.Errorf("got %q", got)
	}
}

func TestIsValidOTP(t *testing.T) {
	if !IsValidOTP("000000") || !IsValidOTP("123456") || !IsValidOTP(" 123456 ") {
		t.Error("six digits must be accepted")
	}
	for _, bad := range []string{"", "12345", "1234567", "12345a", "abcdef", "12 34 56", "-12345"} {
		if IsValidOTP(bad) {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

func TestIsValidName(t *testing.T) {
	// Real names, not just ASCII ones — rejecting these would lock out a large share of the corridor.
	valid := []string{"Ravi Kumar", "O'Brien", "Jean-Luc", "R. Kumar", "Ali", "সৌমেন", "李伟", "José"}
	for _, n := range valid {
		if !IsValidName(n) {
			t.Errorf("%q should be valid", n)
		}
	}

	invalid := []string{
		"", " ", "A", // too short
		"Ravi123",   // digits
		"Ravi@Home", // symbols
		"'Ravi",     // must start with a letter
		"-Ravi",
		".Ravi",
	}
	for _, n := range invalid {
		if IsValidName(n) {
			t.Errorf("%q should be rejected", n)
		}
	}

	tooLong := ""
	for i := 0; i <= NameMax; i++ {
		tooLong += "a"
	}
	if IsValidName(tooLong) {
		t.Error("a name over the cap must be rejected")
	}
}

func TestNormalizeName(t *testing.T) {
	if got := NormalizeName("  Ravi   Kumar  "); got != "Ravi Kumar" {
		t.Errorf("got %q", got)
	}
}

// Per-country length is the point: one hardcoded rule would reject every valid UAE number.
func TestIsValidNationalNumber(t *testing.T) {
	if !IsValidNationalNumber("501234567", "AE") {
		t.Error("9 digits must be valid for AE")
	}
	if IsValidNationalNumber("5012345678", "AE") {
		t.Error("10 digits must be invalid for AE")
	}
	if !IsValidNationalNumber("9876543210", "IN") {
		t.Error("10 digits must be valid for IN")
	}
	if IsValidNationalNumber("987654321", "IN") {
		t.Error("9 digits must be invalid for IN")
	}

	// A leading zero is a trunk prefix; keeping it produces an unreachable number.
	if IsValidNationalNumber("0987654321", "IN") {
		t.Error("a leading zero must be rejected")
	}
	if IsValidNationalNumber("9876543210", "ZZ") {
		t.Error("an unknown country must be rejected")
	}
}

func TestToE164(t *testing.T) {
	if got := ToE164("501234567", "AE"); got != "+971501234567" {
		t.Errorf("got %q", got)
	}
	if got := ToE164("98765 43210", "IN"); got != "+919876543210" {
		t.Errorf("separators should be stripped, got %q", got)
	}
	if ToE164("123", "IN") != "" {
		t.Error("an invalid national number must produce no E.164 string")
	}
}

func TestIsValidE164(t *testing.T) {
	if !IsValidE164("+971501234567") || !IsValidE164("+919876543210") {
		t.Error("well-formed numbers must be accepted")
	}
	for _, bad := range []string{"", "971501234567", "+", "+abc", "+1234567", "+1234567890123456"} {
		if IsValidE164(bad) {
			t.Errorf("%q must be rejected", bad)
		}
	}
}

// Stricter than IsValidE164: a number outside the supported list cannot receive a code, so accepting
// it would strand the user mid-verification.
func TestIsSupportedE164(t *testing.T) {
	if !IsSupportedE164("+971501234567") || !IsSupportedE164("+919876543210") {
		t.Error("supported countries must pass")
	}
	if IsSupportedE164("+9715012345") {
		t.Error("right country, wrong length — must fail")
	}
	if IsSupportedE164("+35312345678") {
		t.Error("an unsupported country must fail")
	}
}

// Every country entry must be usable: the app renders these and the server validates against them.
func TestCountryTableIsWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range Countries {
		if seen[c.Code] {
			t.Errorf("duplicate country code %s", c.Code)
		}
		seen[c.Code] = true

		if len(c.Code) != 2 {
			t.Errorf("%s: code must be alpha-2", c.Code)
		}
		if c.Dial == "" || c.Dial[0] != '+' {
			t.Errorf("%s: dial must start with '+'", c.Code)
		}
		if !digitsRe.MatchString(c.Dial[1:]) {
			t.Errorf("%s: dial must be digits after '+'", c.Code)
		}
		if c.NationalDigits < 4 || c.NationalDigits > 12 {
			t.Errorf("%s: implausible national length %d", c.Code, c.NationalDigits)
		}
		// The composed number must satisfy the E.164 cap, or the country is unusable.
		if len(c.Dial)-1+c.NationalDigits > PhoneDigitsMax {
			t.Errorf("%s: dial + national exceeds E.164's %d digits", c.Code, PhoneDigitsMax)
		}
		if c.Name == "" || c.Flag == "" {
			t.Errorf("%s: name and flag are required for the picker", c.Code)
		}
	}

	if _, ok := FindCountry(DefaultCountry); !ok {
		t.Errorf("DefaultCountry %q is not in the table", DefaultCountry)
	}
	// Case-insensitive lookup, since callers pass whatever the client sent.
	if _, ok := FindCountry("ae"); !ok {
		t.Error("country lookup must be case-insensitive")
	}
}
