package verify

import (
	"crypto/ed25519"
	"encoding/hex"
	"testing"
)

func TestRequestSignature_Valid(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	msg := []byte(`{"test":"body"}`)
	sig := ed25519.Sign(priv, msg)

	err := RequestSignature(hex.EncodeToString(pub), hex.EncodeToString(sig), msg)
	if err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

func TestRequestSignature_Tampered(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	msg := []byte(`{"test":"body"}`)
	sig := ed25519.Sign(priv, msg)
	tampered := []byte(`{"test":"tampered"}`)

	err := RequestSignature(hex.EncodeToString(pub), hex.EncodeToString(sig), tampered)
	if err == nil {
		t.Fatal("expected error for tampered message")
	}
}

func TestRequestSignature_InvalidPubkey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	msg := []byte(`{"test":"body"}`)
	sig := ed25519.Sign(priv, msg)

	err := RequestSignature("nothex", hex.EncodeToString(sig), msg)
	if err == nil {
		t.Fatal("expected error for invalid pubkey hex")
	}
}

func TestRequestSignature_InvalidSig(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	msg := []byte(`{"test":"body"}`)

	err := RequestSignature(hex.EncodeToString(pub), "nothex", msg)
	if err == nil {
		t.Fatal("expected error for invalid signature hex")
	}
}

func TestRequestSignature_WrongPubkey(t *testing.T) {
	pub1, priv, _ := ed25519.GenerateKey(nil)
	pub2, _, _ := ed25519.GenerateKey(nil)
	msg := []byte(`{"test":"body"}`)
	sig := ed25519.Sign(priv, msg)

	err := RequestSignature(hex.EncodeToString(pub2), hex.EncodeToString(sig), msg)
	if err == nil {
		t.Fatal("expected error for wrong pubkey")
	}
	_ = pub1
}
