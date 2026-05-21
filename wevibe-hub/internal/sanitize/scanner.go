package sanitize

import (
	"fmt"
	"strings"
	"unicode"
)

type ScanResult struct {
	Clean    bool      `json:"clean"`
	Findings []Finding `json:"findings,omitempty"`
}

type Finding struct {
	Category    string `json:"category"`
	Description string `json:"description"`
	Position    int    `json:"position"`
	Codepoint   string `json:"codepoint"`
	Severity    string `json:"severity"`
}

func ScanContent(text string) ScanResult {
	var findings []Finding

	if text == "" {
		return ScanResult{Clean: true}
	}

	bytes := []byte(text)
	var consecutiveCombining int
	var combiningStartedAt int

	for i := 0; i < len(bytes); {
		r, size := utf8Decode(bytes[i:])
		pos := i

		if isDangerousControl(r) {
			findings = append(findings, Finding{
				Category:    "control_char",
				Description: "Dangerous control character detected",
				Position:    pos,
				Codepoint:   codepointStr(r),
				Severity:    "critical",
			})
		}

		if isInvisibleUnicode(r) {
			desc := "Invisible Unicode character"
			if r == 0xFEFF && pos > 0 {
				desc = "BOM not at start of text"
			}
			findings = append(findings, Finding{
				Category:    "invisible_unicode",
				Description: desc,
				Position:    pos,
				Codepoint:   codepointStr(r),
				Severity:    "warning",
			})
		}

		if isBidiOverride(r) {
			findings = append(findings, Finding{
				Category:    "bidi_override",
				Description: "Bidirectional override character detected",
				Position:    pos,
				Codepoint:   codepointStr(r),
				Severity:    "critical",
			})
		}

		if isNonStandardSpace(r) {
			findings = append(findings, Finding{
				Category:    "suspicious_space",
				Description: "Non-standard space character detected",
				Position:    pos,
				Codepoint:   codepointStr(r),
				Severity:    "warning",
			})
		}

		if isCombiningMark(r) {
			if combiningStartedAt == -1 {
				combiningStartedAt = pos
			}
			consecutiveCombining++
			if consecutiveCombining > 2 {
				findings = append(findings, Finding{
					Category:    "zalgo",
					Description: "Excessive combining diacritical marks (zalgo text)",
					Position:    combiningStartedAt,
					Codepoint:   codepointStr(r),
					Severity:    "critical",
				})
			}
		} else {
			consecutiveCombining = 0
			combiningStartedAt = -1
		}

		i += size
	}

	hgFindings := detectHomoglyphs(text)
	findings = append(findings, hgFindings...)

	return ScanResult{
		Clean:    len(findings) == 0,
		Findings: findings,
	}
}

func utf8Decode(b []byte) (rune, int) {
	if len(b) == 0 {
		return 0, 0
	}
	r, size := rune(b[0]), 1
	if r >= 0x80 {
		if r&0xE0 == 0xC0 && len(b) >= 2 {
			r = (r & 0x1F) << 6
			r |= rune(b[1] & 0x3F)
			size = 2
		} else if r&0xF0 == 0xE0 && len(b) >= 3 {
			r = (r & 0x0F) << 12
			r |= rune(b[1]&0x3F) << 6
			r |= rune(b[2] & 0x3F)
			size = 3
		} else if r&0xF8 == 0xF0 && len(b) >= 4 {
			r = (r & 0x07) << 18
			r |= rune(b[1]&0x3F) << 12
			r |= rune(b[2]&0x3F) << 6
			r |= rune(b[3] & 0x3F)
			size = 4
		}
	}
	return r, size
}

func isInvisibleUnicode(r rune) bool {
	switch r {
	case 0x200B, 0x200C, 0x200D, 0x2060, 0x00AD:
		return true
	case 0xFEFF:
		return true
	}
	return false
}

func isBidiOverride(r rune) bool {
	switch {
	case r >= 0x202A && r <= 0x202E:
		return true
	case r >= 0x2066 && r <= 0x2069:
		return true
	case r == 0x200E, r == 0x200F:
		return true
	}
	return false
}

func isDangerousControl(r rune) bool {
	switch {
	case r >= 0x0000 && r <= 0x0008:
		return true
	case r == 0x000B, r == 0x000C:
		return true
	case r >= 0x000E && r <= 0x001F:
		return true
	case r == 0x007F:
		return true
	case r >= 0x0080 && r <= 0x009F:
		return true
	}
	return false
}

func isNonStandardSpace(r rune) bool {
	switch {
	case r == 0x00A0:
		return true
	case r == 0x1680:
		return true
	case r >= 0x2000 && r <= 0x200A:
		return true
	case r == 0x202F:
		return true
	case r == 0x205F:
		return true
	case r == 0x3000:
		return true
	}
	return false
}

func isCombiningMark(r rune) bool {
	return unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Mc, r)
}

func codepointStr(r rune) string {
	return strings.ToUpper(fmt.Sprintf("U+%04X", r))
}
