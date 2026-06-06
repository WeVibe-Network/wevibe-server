package hubsign

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSigningMiddlewareSignsAndPreservesResponse(t *testing.T) {
	t.Setenv(ResponseSeedEnv, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")

	signer, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv() error = %v", err)
	}

	const body = "known-response-body"

	h := SigningMiddleware(signer)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("X-Test-Header", "kept")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(body))
	}))

	req := httptest.NewRequest(http.MethodGet, "/test", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusCreated)
	}

	if got := rr.Body.String(); got != body {
		t.Fatalf("body = %q, want %q", got, body)
	}

	if got := rr.Header().Get("X-Test-Header"); got != "kept" {
		t.Fatalf("X-Test-Header = %q, want %q", got, "kept")
	}

	sigHex := rr.Header().Get(SignatureHeader)
	if sigHex == "" {
		t.Fatalf("%s header missing", SignatureHeader)
	}
	if sigHex != strings.ToLower(sigHex) {
		t.Fatalf("signature header is not lowercase hex: %q", sigHex)
	}

	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		t.Fatalf("decode signature hex: %v", err)
	}

	pubkeyBytes, err := hex.DecodeString(signer.PublicKeyHex())
	if err != nil {
		t.Fatalf("decode pubkey hex: %v", err)
	}

	digest := sha256.Sum256([]byte(body))
	if !ed25519.Verify(ed25519.PublicKey(pubkeyBytes), digest[:], sigBytes) {
		t.Fatalf("signature does not verify")
	}
}
