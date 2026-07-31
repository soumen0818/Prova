package schema

import (
	"regexp"
	"strings"
	"unicode"
)

// Input validation rules — FROZEN, and the single source of truth for the backend. Mirrors
// validation.ts exactly.
//
// Client-side validation is a courtesy: it makes a form pleasant. THIS is the actual control,
// because anything can post to the API. The two used to be separate copies, which meant they could
// drift — and a drift here is either a silently rejected sign-up or junk reaching the database.
//
// Both sides have tests over the same cases. Never tighten one without the other.
//
// Amounts, commitments and proofs are deliberately absent: those are enforced by the circuit and the
// contract, which is a far stronger guarantee than any string check.

const (
	// EmailMax / EmailLocalMax are RFC 5321's caps.
	EmailMax      = 254
	EmailLocalMax = 64

	NameMin = 2
	NameMax = 60

	OTPLength = 6

	// E.164 allows 15 digits total; 8 is a sane practical floor.
	PhoneDigitsMin = 8
	PhoneDigitsMax = 15
)

// Country is a supported dialling country.
//
// NationalDigits is how many digits follow the dial code. It is per-country because it genuinely
// differs — India is 10, the UAE is 9 — and one hardcoded length would reject every valid UAE
// number, which is half of Prova's corridor.
type Country struct {
	Code           string `json:"code"`
	Name           string `json:"name"`
	Dial           string `json:"dial"`
	NationalDigits int    `json:"nationalDigits"`
	Flag           string `json:"flag"`
}

// Countries lists every supported country, corridor first. Mirrors COUNTRIES in validation.ts.
var Countries = []Country{
	{Code: "AE", Name: "United Arab Emirates", Dial: "+971", NationalDigits: 9, Flag: "🇦🇪"},
	{Code: "IN", Name: "India", Dial: "+91", NationalDigits: 10, Flag: "🇮🇳"},
	{Code: "PK", Name: "Pakistan", Dial: "+92", NationalDigits: 10, Flag: "🇵🇰"},
	{Code: "BD", Name: "Bangladesh", Dial: "+880", NationalDigits: 10, Flag: "🇧🇩"},
	{Code: "PH", Name: "Philippines", Dial: "+63", NationalDigits: 10, Flag: "🇵🇭"},
	{Code: "LK", Name: "Sri Lanka", Dial: "+94", NationalDigits: 9, Flag: "🇱🇰"},
	{Code: "NP", Name: "Nepal", Dial: "+977", NationalDigits: 10, Flag: "🇳🇵"},
	{Code: "EG", Name: "Egypt", Dial: "+20", NationalDigits: 10, Flag: "🇪🇬"},
	{Code: "SA", Name: "Saudi Arabia", Dial: "+966", NationalDigits: 9, Flag: "🇸🇦"},
	{Code: "GB", Name: "United Kingdom", Dial: "+44", NationalDigits: 10, Flag: "🇬🇧"},
	{Code: "US", Name: "United States", Dial: "+1", NationalDigits: 10, Flag: "🇺🇸"},
}

// DefaultCountry is the sending side of the corridor.
const DefaultCountry = "AE"

// FindCountry returns the country for an ISO alpha-2 code.
func FindCountry(code string) (Country, bool) {
	up := strings.ToUpper(strings.TrimSpace(code))
	for _, c := range Countries {
		if c.Code == up {
			return c, true
		}
	}
	return Country{}, false
}

// DigitsOf keeps only 0-9.
func DigitsOf(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

var (
	emailLocalRe  = regexp.MustCompile(`^[A-Za-z0-9!#$%&'*+/=?^_` + "`" + `{|}~.-]+$`)
	emailDomainRe = regexp.MustCompile(`^[A-Za-z0-9.-]+$`)
	emailTLDRe    = regexp.MustCompile(`^[A-Za-z]{2,}$`)
	otpRe         = regexp.MustCompile(`^\d{6}$`)
	digitsRe      = regexp.MustCompile(`^\d+$`)
)

// IsValidEmail is a practical check, deliberately not an RFC 5322 regex: those accept addresses no
// provider will deliver to and reject some that work. The real proof an address exists is that its
// one-time code arrives, so this only catches obvious mistakes before one is sent.
func IsValidEmail(input string) bool {
	v := strings.TrimSpace(input)
	if v == "" || len(v) > EmailMax {
		return false
	}
	if strings.ContainsAny(v, " \t\r\n") {
		return false
	}

	at := strings.LastIndex(v, "@")
	if at <= 0 || at == len(v)-1 {
		return false
	}
	local, domain := v[:at], v[at+1:]
	if len(local) > EmailLocalMax {
		return false
	}
	if strings.HasPrefix(local, ".") || strings.HasSuffix(local, ".") || strings.Contains(local, "..") {
		return false
	}
	if strings.HasPrefix(domain, ".") || strings.HasSuffix(domain, ".") || strings.Contains(domain, "..") {
		return false
	}
	if strings.HasPrefix(domain, "-") || strings.HasSuffix(domain, "-") {
		return false
	}
	if !emailDomainRe.MatchString(domain) {
		return false
	}
	lastDot := strings.LastIndex(domain, ".")
	if lastDot <= 0 || len(domain)-lastDot-1 < 2 {
		return false
	}
	if !emailTLDRe.MatchString(domain[lastDot+1:]) {
		return false
	}
	return emailLocalRe.MatchString(local)
}

// NormalizeEmail trims and lowercases, so storage and comparison are stable.
func NormalizeEmail(input string) string {
	return strings.ToLower(strings.TrimSpace(input))
}

// IsValidOTP: exactly OTPLength digits and nothing else.
func IsValidOTP(input string) bool {
	return otpRe.MatchString(strings.TrimSpace(input))
}

// IsValidName accepts Unicode letters and COMBINING MARKS, plus the separators real names use —
// apostrophes, hyphens, dots and spaces (O'Brien, Jean-Luc, R. Kumar). Digits and symbols are
// rejected.
//
// The combining marks matter: in Bengali, Devanagari, Tamil and most Indic scripts the vowel signs
// (matras) are marks, not letters. A letters-only rule silently rejects names like "সৌমেন" — which
// would lock out a large share of this corridor's users, and is the kind of failure nobody reports
// because they simply give up on the form.
func IsValidName(input string) bool {
	v := strings.TrimSpace(input)
	runes := []rune(v)
	if len(runes) < NameMin || len(runes) > NameMax {
		return false
	}
	for i, r := range runes {
		switch {
		case unicode.IsLetter(r):
			// always fine
		case unicode.IsMark(r):
			if i == 0 {
				return false // a name cannot begin with a combining mark
			}
		case r == ' ' || r == '.' || r == '\'' || r == '-':
			if i == 0 {
				return false // must start with a letter
			}
		default:
			return false
		}
	}
	return true
}

// NormalizeName collapses internal whitespace so " Ravi   Kumar " and "Ravi Kumar" store identically.
func NormalizeName(input string) string {
	return strings.Join(strings.Fields(input), " ")
}

// IsValidNationalNumber checks the digits typed after the dial code, against that country's own
// expected length.
func IsValidNationalNumber(national, countryCode string) bool {
	country, ok := FindCountry(countryCode)
	if !ok {
		return false
	}
	digits := DigitsOf(national)
	if len(digits) != country.NationalDigits {
		return false
	}
	// A leading 0 is a trunk prefix users type out of habit; keeping it yields an unreachable
	// E.164 number.
	return !strings.HasPrefix(digits, "0")
}

// ToE164 builds the stored number: "+<dial><national>". Empty string if invalid.
func ToE164(national, countryCode string) string {
	country, ok := FindCountry(countryCode)
	if !ok || !IsValidNationalNumber(national, countryCode) {
		return ""
	}
	return country.Dial + DigitsOf(national)
}

// IsValidE164 re-checks a whole number as received by the API — the server cannot assume the client
// composed it correctly.
func IsValidE164(input string) bool {
	v := strings.TrimSpace(input)
	if !strings.HasPrefix(v, "+") {
		return false
	}
	digits := v[1:]
	if !digitsRe.MatchString(digits) {
		return false
	}
	return len(digits) >= PhoneDigitsMin && len(digits) <= PhoneDigitsMax
}

// IsSupportedE164 is stricter: the number must match one of the supported countries exactly. Used by
// the KYC step, because a number outside the list cannot receive a code and would strand the user
// mid-verification.
func IsSupportedE164(input string) bool {
	v := strings.TrimSpace(input)
	if !IsValidE164(v) {
		return false
	}
	for _, c := range Countries {
		if strings.HasPrefix(v, c.Dial) && len(v)-len(c.Dial) == c.NationalDigits {
			return true
		}
	}
	return false
}

// --- Opaque identifiers ---

var hex32Re = regexp.MustCompile(`^[0-9a-f]{64}$`)

// IsValidUserID checks the opaque wallet identifier: `Poseidon(ownerSk, domain)` as 32-byte
// lowercase hex.
//
// It has a known shape, so the server can and should insist on it. Accepting free text would let
// anything become a row in the verification table — an easy way to pollute the KYC audit trail,
// which is the one record a regulator will actually ask to see.
func IsValidUserID(input string) bool {
	return hex32Re.MatchString(strings.TrimSpace(input))
}

// IsValidTier reports whether a KYC tier is one the system defines.
func IsValidTier(tier int) bool {
	return tier >= TierBasic && tier <= TierEnhanced
}

// IsValidHex32 checks a 32-byte lowercase-hex field element (commitment, nullifier, root).
func IsValidHex32(input string) bool {
	return hex32Re.MatchString(strings.TrimSpace(input))
}

// stellarAddressRe matches a Stellar ed25519 public key: 'G' plus 55 base32 characters.
var stellarAddressRe = regexp.MustCompile(`^G[A-Z2-7]{55}$`)

// IsValidStellarAddress checks the shape of a `G…` account address.
//
// Shape only — it does not verify the checksum or that the account exists, which are the network's
// job. The point is to reject obvious junk before it becomes a Horizon call or a funding attempt,
// so a typo fails fast and locally instead of as an opaque upstream error.
func IsValidStellarAddress(input string) bool {
	return stellarAddressRe.MatchString(strings.TrimSpace(input))
}
