package sanitize

import (
	"testing"
)

func TestScanContent_CleanText(t *testing.T) {
	result := ScanContent("Hello, World!")
	if !result.Clean {
		t.Error("Expected clean text to return clean=true")
	}
	if len(result.Findings) != 0 {
		t.Errorf("Expected no findings, got %d", len(result.Findings))
	}
}

func TestScanContent_ZeroWidthSpace(t *testing.T) {
	result := ScanContent("Hello\u200bWorld")
	if result.Clean {
		t.Error("Expected text with U+200B to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "invisible_unicode" && f.Codepoint == "U+200B" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find invisible_unicode finding for U+200B")
	}
}

func TestScanContent_ZeroWidthJoiner(t *testing.T) {
	result := ScanContent("test\u200dtest")
	if result.Clean {
		t.Error("Expected text with U+200D to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "invisible_unicode" && f.Codepoint == "U+200D" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find invisible_unicode finding for U+200D")
	}
}

func TestScanContent_BidiOverride(t *testing.T) {
	result := ScanContent("test\u202btest")
	if result.Clean {
		t.Error("Expected text with U+202B to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "bidi_override" && f.Codepoint == "U+202B" {
			found = true
			if f.Severity != "critical" {
				t.Errorf("Expected severity critical, got %s", f.Severity)
			}
			break
		}
	}
	if !found {
		t.Error("Expected to find bidi_override finding for U+202B")
	}
}

func TestScanContent_ControlCharacter(t *testing.T) {
	result := ScanContent("test\u0000test")
	if result.Clean {
		t.Error("Expected text with U+0000 to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "control_char" && f.Codepoint == "U+0000" {
			found = true
			if f.Severity != "critical" {
				t.Errorf("Expected severity critical, got %s", f.Severity)
			}
			break
		}
	}
	if !found {
		t.Error("Expected to find control_char finding for U+0000")
	}
}

func TestScanContent_TabNewlineCR_Allowed(t *testing.T) {
	result := ScanContent("hello\tworld\nand\rcarriage")
	if !result.Clean {
		t.Error("Tab, newline, and CR should be allowed")
	}
	for _, f := range result.Findings {
		if f.Category == "control_char" {
			t.Error("Tab, newline, and CR should not be flagged as control characters")
		}
	}
}

func TestScanContent_NonStandardSpace(t *testing.T) {
	result := ScanContent("hello\u00a0world")
	if result.Clean {
		t.Error("Expected text with U+00A0 to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "suspicious_space" && f.Codepoint == "U+00A0" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find suspicious_space finding for U+00A0")
	}
}

func TestScanContent_HomoglyphCyrillic(t *testing.T) {
	result := ScanContent("test\u0430test")
	if result.Clean {
		t.Error("Expected text with Cyrillic 'а' to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "homoglyph" && f.Codepoint == "U+0430" {
			found = true
			break
		}
	}
	if !found {
		t.Error("Expected to find homoglyph finding for Cyrillic U+0430")
	}
}

func TestScanContent_ZalgoText(t *testing.T) {
	text := "a\u0301\u0301\u0301\u0301"
	result := ScanContent(text)
	if result.Clean {
		t.Error("Expected zalgo text to not be clean")
	}
	found := false
	for _, f := range result.Findings {
		if f.Category == "zalgo" {
			found = true
			if f.Severity != "critical" {
				t.Errorf("Expected severity critical for zalgo, got %s", f.Severity)
			}
			break
		}
	}
	if !found {
		t.Error("Expected to find zalgo finding")
	}
}

func TestScanContent_MixedFindings(t *testing.T) {
	text := "test\u0000test\u200Btest\u0430test"
	result := ScanContent(text)
	if result.Clean {
		t.Error("Expected mixed text to not be clean")
	}
	if len(result.Findings) < 3 {
		t.Errorf("Expected at least 3 findings, got %d", len(result.Findings))
	}
}

func TestScanContent_EmptyString(t *testing.T) {
	result := ScanContent("")
	if !result.Clean {
		t.Error("Expected empty string to return clean=true")
	}
	if len(result.Findings) != 0 {
		t.Errorf("Expected no findings for empty string, got %d", len(result.Findings))
	}
}

func TestScanContent_ASCIIOnly(t *testing.T) {
	result := ScanContent("ASCII only text 123 !@#")
	if !result.Clean {
		t.Error("Expected ASCII-only text to be clean")
	}
}

func TestScanContent_LegitimateMultilingual(t *testing.T) {
	result := ScanContent("こんにちはمرحباПривет")
	if !result.Clean {
		t.Errorf("Expected legitimate multilingual text to be clean, got %d findings", len(result.Findings))
	}
	for _, f := range result.Findings {
		if f.Category == "homoglyph" {
			t.Error("CJK, Arabic, Cyrillic text should not be flagged as homoglyphs")
		}
	}
}
