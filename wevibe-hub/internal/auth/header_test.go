package auth

import (
	"net/http"
	"testing"
)

func makeRequest(authHeader string) *http.Request {
	r, _ := http.NewRequest("GET", "/test", nil)
	if authHeader != "" {
		r.Header.Set("Authorization", authHeader)
	}
	return r
}

func TestParseWeVibeSigned_Valid(t *testing.T) {
	r := makeRequest("WeVibe-Signed pubkey=aabbccdd,timestamp=2026-04-01T12:00:00Z,signature=11223344")
	auth, err := ParseWeVibeSigned(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.Pubkey != "aabbccdd" {
		t.Errorf("pubkey: got %q, want aabbccdd", auth.Pubkey)
	}
	if auth.Timestamp != "2026-04-01T12:00:00Z" {
		t.Errorf("timestamp: got %q", auth.Timestamp)
	}
	if auth.Signature != "11223344" {
		t.Errorf("signature: got %q, want 11223344", auth.Signature)
	}
}

func TestParseWeVibeSigned_MissingHeader(t *testing.T) {
	r := makeRequest("")
	_, err := ParseWeVibeSigned(r)
	if err != ErrMissingHeader {
		t.Errorf("expected ErrMissingHeader, got %v", err)
	}
}

func TestParseWeVibeSigned_WrongScheme(t *testing.T) {
	tests := []string{
		"Bearer token123",
		"Basic dXNlcjpwYXNz",
		"wevibe-signed pubkey=a,timestamp=b,signature=c",
		"WEVIBE-SIGNED pubkey=a,timestamp=b,signature=c",
	}
	for _, h := range tests {
		r := makeRequest(h)
		_, err := ParseWeVibeSigned(r)
		if err != ErrInvalidScheme {
			t.Errorf("header %q: expected ErrInvalidScheme, got %v", h, err)
		}
	}
}

func TestParseWeVibeSigned_MalformedCases(t *testing.T) {
	tests := []struct {
		name   string
		header string
	}{
		{"empty credentials", "WeVibe-Signed "},
		{"missing fields", "WeVibe-Signed pubkey=abc"},
		{"two fields only", "WeVibe-Signed pubkey=abc,timestamp=2026-01-01T00:00:00Z"},
		{"four fields", "WeVibe-Signed pubkey=a,timestamp=b,signature=c,extra=d"},
		{"wrong order", "WeVibe-Signed timestamp=b,pubkey=a,signature=c"},
		{"missing pubkey value", "WeVibe-Signed pubkey=,timestamp=b,signature=c"},
		{"missing timestamp value", "WeVibe-Signed pubkey=a,timestamp=,signature=c"},
		{"missing signature value", "WeVibe-Signed pubkey=a,timestamp=b,signature="},
		{"wrong key name", "WeVibe-Signed public_key=a,timestamp=b,signature=c"},
		{"spaces around comma", "WeVibe-Signed pubkey=a, timestamp=b, signature=c"},
		{"no equals", "WeVibe-Signed pubkey:a,timestamp:b,signature:c"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := makeRequest(tt.header)
			_, err := ParseWeVibeSigned(r)
			if err == nil {
				t.Errorf("expected error for %q, got nil", tt.header)
			}
		})
	}
}

func TestParseWeVibeSigned_TimestampWithOffset(t *testing.T) {
	r := makeRequest("WeVibe-Signed pubkey=aa,timestamp=2026-04-01T17:30:00+05:30,signature=bb")
	auth, err := ParseWeVibeSigned(r)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if auth.Timestamp != "2026-04-01T17:30:00+05:30" {
		t.Errorf("timestamp: got %q", auth.Timestamp)
	}
}
