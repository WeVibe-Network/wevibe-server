package hubsign

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func TestNewFromEnvDeterministic(t *testing.T) {
	t.Setenv(ResponseSeedEnv, "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f")

	signerA, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv() error = %v", err)
	}
	signerB, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv() second call error = %v", err)
	}

	if signerA.PublicKeyHex() != signerB.PublicKeyHex() {
		t.Fatalf("public keys differ for same seed: %s vs %s", signerA.PublicKeyHex(), signerB.PublicKeyHex())
	}

	body := []byte("deterministic-body")
	sigA := signerA.SignBody(body)
	sigB := signerB.SignBody(body)
	if !bytes.Equal(sigA, sigB) {
		t.Fatalf("signatures differ for same seed/body")
	}
}

func TestSignVerifyRoundTrip(t *testing.T) {
	t.Setenv(ResponseSeedEnv, "1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100")

	signer, err := NewFromEnv()
	if err != nil {
		t.Fatalf("NewFromEnv() error = %v", err)
	}

	body := []byte("response-body-to-sign")
	digest := sha256.Sum256(body)
	signature := signer.Sign(digest[:])

	pubkeyBytes, err := hex.DecodeString(signer.PublicKeyHex())
	if err != nil {
		t.Fatalf("decode pubkey hex: %v", err)
	}

	if !ed25519.Verify(ed25519.PublicKey(pubkeyBytes), digest[:], signature) {
		t.Fatalf("ed25519.Verify returned false")
	}
}
