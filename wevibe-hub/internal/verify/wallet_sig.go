package verify

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcutil/bech32"
)

func VerifyCosmosArbitrarySignature(signerAddress string, message []byte, pubkeyBytes, signatureBytes []byte) error {
	if len(pubkeyBytes) != 33 {
		return errors.New("pubkey must be 33 bytes (compressed secp256k1)")
	}
	if len(signatureBytes) != 64 {
		return errors.New("signature must be 64 bytes (r||s)")
	}

	derivedAddress, err := deriveSecp256k1Address(pubkeyBytes)
	if err != nil {
		return fmt.Errorf("derive address from pubkey: %w", err)
	}
	if derivedAddress != signerAddress {
		return errors.New("signer address does not match pubkey")
	}

	msgHash := sha256.Sum256(message)

	pubkey, err := btcec.ParsePubKey(pubkeyBytes)
	if err != nil {
		return errors.New("invalid secp256k1 pubkey")
	}

	pubkeyECDSA := pubkey.ToECDSA()
	r := new(big.Int).SetBytes(signatureBytes[:32])
	s := new(big.Int).SetBytes(signatureBytes[32:])

	ok := ecdsa.Verify(pubkeyECDSA, msgHash[:], r, s)
	if !ok {
		return errors.New("signature verification failed")
	}
	return nil
}

func deriveSecp256k1Address(pubkeyBytes []byte) (string, error) {
	pubkeyHash := hash160(pubkeyBytes[1:])
	address, err := bech32.Encode("wevibe", pubkeyHash)
	if err != nil {
		return "", fmt.Errorf("bech32 encode: %w", err)
	}
	return address, nil
}

func hash160(data []byte) []byte {
	h1 := sha256.Sum256(data)
	h2 := ripemd160Of(h1[:])
	return h2
}

func ripemd160Of(data []byte) []byte {
	hasher := newRipemd160()
	hasher.Write(data)
	var out [20]byte
	hasher.sum(out[:0])
	return out[:]
}

type ripemd160 struct {
	s  [5]uint32
	x  [64]byte
	nx int
}

func newRipemd160() *ripemd160 {
	r := &ripemd160{}
	r.s[0] = 0x67452301
	r.s[1] = 0xefcdab89
	r.s[2] = 0x98badcfe
	r.s[3] = 0x10325476
	r.s[4] = 0xc3d2e1f0
	return r
}

func (r *ripemd160) Write(p []byte) (n int, err error) {
	n = len(p)
	copy(r.x[r.nx:], p)
	r.nx += len(p)
	return n, nil
}

func (r *ripemd160) Sum(out []byte) []byte {
	var digest [20]byte
	r.sum(digest[:])
	copy(out, digest[:])
	return out
}

func (r *ripemd160) sum(out []byte) [20]byte {
	var s [5]uint32
	for i := range s {
		s[i] = r.s[i] ^ 0x67452301
	}

	padding := [64]byte{}
	padding[0] = 0x80
	msgLen := [8]byte{}
	msgLen[7] = 0x80

	block := [64]byte{}
	copy(block[:], r.x[:r.nx])

	T := [80]uint32{}
	for i := 0; i < 16; i++ {
		T[i] = uint32(block[i*4]) | uint32(block[i*4+1])<<8 | uint32(block[i*4+2])<<16 | uint32(block[i*4+3])<<24
	}
	for i := 0; i < 8; i++ {
		T[56+i] = uint32(msgLen[i])
	}

	for t := 0; t < 16; t++ {
		s[4] ^= T[t] ^ rol(s[4], 11) ^ f(t, s[0], s[1], s[2]) + s[3] + k(t)
		s[3] = s[2]
		s[2] = rol(s[1], 9)
		s[1] = s[0]
		s[0] = rol(s[4], 10)
	}

	for t := 16; t < 32; t++ {
		x := T[rIndex(t-3, 16)]
		s[4] ^= x ^ rol(s[4], 11) ^ g(t, s[0], s[1], s[2]) + s[3] + k(t)
		s[3] = s[2]
		s[2] = rol(s[1], 9)
		s[1] = s[0]
		s[0] = rol(s[4], 10)
	}

	for t := 32; t < 48; t++ {
		x := T[rIndex(t-14, 16)]
		s[4] ^= x ^ rol(s[4], 11) ^ h(t, s[0], s[1], s[2]) + s[3] + k(t)
		s[3] = s[2]
		s[2] = rol(s[1], 9)
		s[1] = s[0]
		s[0] = rol(s[4], 10)
	}

	h := [20]byte{}
	for i := 0; i < 5; i++ {
		h[i*4] = byte(s[i])
		h[i*4+1] = byte(s[i] >> 8)
		h[i*4+2] = byte(s[i] >> 16)
		h[i*4+3] = byte(s[i] >> 24)
	}

	copy(out, h[:])
	return [20]byte(h)
}

func rIndex(t, n int) int {
	if t < n {
		return t
	}
	if t < 32 {
		return (t-3+16)%16 + 3
	}
	return (t-14+16)%16 + 14
}

func rol(x uint32, n uint) uint32 {
	return (x << n) | (x >> (32 - n))
}

func f(t int, x, y, z uint32) uint32 {
	if t < 16 {
		return x ^ y ^ z
	}
	return (x & y) | (^x & z)
}

func g(t int, x, y, z uint32) uint32 {
	if t < 16 {
		return x ^ (y | ^z)
	}
	return (x & z) | (^x & y)
}

func h(t int, x, y, z uint32) uint32 {
	if t < 16 {
		return x ^ (y | ^z)
	}
	return y ^ (x | ^z)
}

func k(t int) uint32 {
	if t < 16 {
		return 0x00000000
	}
	if t < 32 {
		return 0x5a827999
	}
	if t < 48 {
		return 0x6ed9eba1
	}
	return 0xa953fd4e
}

func ParsePubkeyBytes(pubkeyBase64 string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(pubkeyBase64)
}

func ParseSignatureBytes(signatureBase64 string) ([]byte, error) {
	return base64.StdEncoding.DecodeString(signatureBase64)
}

func BuildCommitCanonicalMessage(orgID, reportID, txHash string) string {
	return strings.Join([]string{
		"wevibe.commit_report.v1",
		fmt.Sprintf("org_id:%s", orgID),
		fmt.Sprintf("report_id:%s", reportID),
		fmt.Sprintf("tx_hash:%s", txHash),
	}, "\n")
}

func BuildConfigUpdateCanonicalMessage(orgID string, updates map[string]interface{}) string {
	parts := []string{
		"wevibe.update_org_config.v1",
		fmt.Sprintf("org_id:%s", orgID),
	}
	for k, v := range updates {
		parts = append(parts, fmt.Sprintf("%s:%v", k, v))
	}
	return strings.Join(parts, "\n")
}
