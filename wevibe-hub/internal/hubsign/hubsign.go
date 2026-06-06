package hubsign

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"strings"
)

const (
	ResponseSeedEnv = "WEVIBE_HUB_RESPONSE_SEED"
	SignatureHeader = "X-Hub-Signature"
)

type Signer struct {
	privateKey   ed25519.PrivateKey
	publicKeyHex string
}

func NewFromEnv() (*Signer, error) {
	seedHex := strings.TrimSpace(os.Getenv(ResponseSeedEnv))
	if seedHex != "" {
		seed, err := hex.DecodeString(seedHex)
		if err != nil {
			return nil, fmt.Errorf("%s must be lowercase hex: %w", ResponseSeedEnv, err)
		}
		if len(seed) != ed25519.SeedSize {
			return nil, fmt.Errorf("%s must decode to %d bytes", ResponseSeedEnv, ed25519.SeedSize)
		}

		privateKey := ed25519.NewKeyFromSeed(seed)
		publicKey := privateKey.Public().(ed25519.PublicKey)
		return &Signer{
			privateKey:   privateKey,
			publicKeyHex: hex.EncodeToString(publicKey),
		}, nil
	}

	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate response signing key: %w", err)
	}
	publicKeyHex := hex.EncodeToString(publicKey)
	log.Printf("WARNING: %s is unset; generated ephemeral hub response signing key (set this env in production). response_pubkey=%s", ResponseSeedEnv, publicKeyHex)

	return &Signer{
		privateKey:   privateKey,
		publicKeyHex: publicKeyHex,
	}, nil
}

func (s *Signer) PublicKeyHex() string {
	return s.publicKeyHex
}

func (s *Signer) Sign(digest []byte) []byte {
	return ed25519.Sign(s.privateKey, digest)
}

func (s *Signer) SignBody(body []byte) []byte {
	digest := sha256.Sum256(body)
	return s.Sign(digest[:])
}
