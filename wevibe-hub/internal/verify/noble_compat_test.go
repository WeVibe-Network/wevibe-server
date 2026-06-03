package verify

import (
	"encoding/hex"
	"testing"
)

const (
	nobleProducedPubkeyHex    = "8cd379f8d42d3e909d9a4a8a6e3c662676942f8d7d0e67e2cf860855b342344e"
	signedTimestamp           = "2026-06-02T12:00:00Z"
	nobleProducedSignatureHex = "056aa6e1cad20e9770642d5b9ca90b57502f706e1a667549636ded77d93f738b7634bfb46820d9ec969e99d2dc72079bac838000240863ea457dcab08b2e290d"
)

// This vector is produced by the dashboard's @noble/ed25519 derivation/signing
// pipeline and locks noble↔Go-stdlib compatibility for the WeVibe-Signed scheme.
func TestRequestSignature_NobleDashboardCompat(t *testing.T) {
	err := RequestSignature(nobleProducedPubkeyHex, nobleProducedSignatureHex, []byte(signedTimestamp))
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestRequestSignature_NobleDashboardCompat_NegativeControl(t *testing.T) {
	tamperedSigBytes, err := hex.DecodeString(nobleProducedSignatureHex)
	if err != nil {
		t.Fatalf("failed decoding signature vector: %v", err)
	}
	tamperedSigBytes[0] ^= 0x01

	err = RequestSignature(nobleProducedPubkeyHex, hex.EncodeToString(tamperedSigBytes), []byte(signedTimestamp))
	if err == nil {
		t.Fatal("expected error for tampered signature")
	}

	err = RequestSignature(nobleProducedPubkeyHex, nobleProducedSignatureHex, []byte("2026-06-02T12:00:01Z"))
	if err == nil {
		t.Fatal("expected error for mismatched timestamp")
	}
}
