package verify

import (
	"crypto/ed25519"
	"encoding/hex"
	"errors"
)

func RequestSignature(pubkeyHex, sigHex string, message []byte) error {
	pubkeyBytes, err := hex.DecodeString(pubkeyHex)
	if err != nil {
		return errors.New("invalid pubkey hex")
	}
	if len(pubkeyBytes) != ed25519.PublicKeySize {
		return errors.New("pubkey must be 32 bytes")
	}
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return errors.New("invalid signature hex")
	}
	if len(sigBytes) != ed25519.SignatureSize {
		return errors.New("signature must be 64 bytes")
	}
	if !ed25519.Verify(ed25519.PublicKey(pubkeyBytes), message, sigBytes) {
		return errors.New("signature verification failed")
	}
	return nil
}
