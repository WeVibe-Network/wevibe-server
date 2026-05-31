package relay

import (
	"crypto/ecdsa"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"strings"
	"time"

	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptotypes "github.com/cosmos/cosmos-sdk/crypto/types"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authsigning "github.com/cosmos/cosmos-sdk/x/auth/signing"
	authztypes "github.com/cosmos/cosmos-sdk/x/authz"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrMissingOrgID        = errors.New("org_id field missing in canonical body")
	ErrMissingWalletAddr   = errors.New("wallet_address field missing in canonical body")
	ErrMissingTxBytes      = errors.New("tx_bytes_base64 field missing in canonical body")
	ErrWrongHeader         = errors.New("canonical body must start with WV-RELAY-v1")
	ErrNoDelegateKey       = errors.New("no active delegate key found for wallet")
	ErrExpiredDelegate     = errors.New("delegate key has expired")
	ErrInvalidPubkey       = errors.New("invalid delegate pubkey")
	ErrInvalidSignature    = errors.New("invalid signature")
	ErrSignatureVerifyFail = errors.New("signature verification failed")
	ErrNoMsgsInExec        = errors.New("MsgExec contains no messages")
	ErrGranterMismatch     = errors.New("inner messages have different granters")
	ErrDisallowedType      = errors.New("message type not allowed for relay")
	ErrUnexpectedMsgType   = errors.New("expected MsgExec, got different message type")
	// Direct (non-delegate) leader-signing path (D-S32-CO044-LEADER-DUAL-PATH).
	ErrNotSigVerifiable = errors.New("tx is not signature-verifiable")
	ErrMultipleSigners  = errors.New("direct relay tx must have exactly one signer")
	ErrSignerMismatch   = errors.New("tx signer does not match wallet_address")
	ErrNoMsgs           = errors.New("tx contains no messages")
)

// verifySecp256k1Signature verifies a 64-byte (r||s) ECDSA signature over
// sha256(canonicalBody) against a 33-byte compressed secp256k1 pubkey. Shared
// by the delegate path (delegate session key) and the direct path (leader
// wallet key) — D-S32-CO044-LEADER-DUAL-PATH.
func verifySecp256k1Signature(pubkeyBytes []byte, canonicalBody, sigB64 string) error {
	if len(pubkeyBytes) != 33 {
		return ErrInvalidPubkey
	}

	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		return ErrInvalidSignature
	}
	if len(sigBytes) != 64 {
		return ErrInvalidSignature
	}

	msgHash := sha256.Sum256([]byte(canonicalBody))

	btcecPubkey, err := btcec.ParsePubKey(pubkeyBytes)
	if err != nil {
		return ErrInvalidPubkey
	}

	ecdsaPubkey := btcecPubkey.ToECDSA()
	r := new(big.Int).SetBytes(sigBytes[:32])
	s := new(big.Int).SetBytes(sigBytes[32:])

	if !ecdsa.Verify(ecdsaPubkey, msgHash[:], r, s) {
		return ErrSignatureVerifyFail
	}

	return nil
}

func ParseCanonicalBody(raw []byte) (orgID, walletAddr, txBytesB64 string, err error) {
	body := string(raw)
	if !strings.HasPrefix(body, "WV-RELAY-v1\n") {
		return "", "", "", ErrWrongHeader
	}

	lines := strings.Split(body, "\n")
	result := make(map[string]string)
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		key := line[:idx]
		value := line[idx+1:]
		result[key] = value
	}

	orgID, ok := result["org_id"]
	if !ok || orgID == "" {
		return "", "", "", ErrMissingOrgID
	}
	walletAddr, ok = result["wallet_address"]
	if !ok || walletAddr == "" {
		return "", "", "", ErrMissingWalletAddr
	}
	txBytesB64, ok = result["tx_bytes_base64"]
	if !ok || txBytesB64 == "" {
		return "", "", "", ErrMissingTxBytes
	}

	return orgID, walletAddr, txBytesB64, nil
}

func VerifyDelegateSignature(pool *pgxpool.Pool, walletAddr, canonicalBody, sigB64 string) error {
	var delegatePubkey string
	var grantExpiration *time.Time
	err := pool.QueryRow(nil, `
		SELECT delegate_pubkey, grant_expiration
		FROM delegate_keys
		WHERE wallet_address = $1 AND active = true
	`, walletAddr).Scan(&delegatePubkey, &grantExpiration)
	if err != nil {
		return ErrNoDelegateKey
	}

	if grantExpiration != nil && !time.Now().Before(*grantExpiration) {
		return ErrExpiredDelegate
	}

	pubkeyBytes, err := base64.StdEncoding.DecodeString(delegatePubkey)
	if err != nil {
		return ErrInvalidPubkey
	}
	if len(pubkeyBytes) != 33 {
		return ErrInvalidPubkey
	}

	return verifySecp256k1Signature(pubkeyBytes, canonicalBody, sigB64)
}

// ExtractSingleSignerPubKey returns the sole signer pubkey of a directly-signed
// tx (the direct/non-delegate leader-signing path). Direct relay txs must carry
// exactly one signer — the leader wallet.
func ExtractSingleSignerPubKey(tx sdk.Tx) (cryptotypes.PubKey, error) {
	sigTx, ok := tx.(authsigning.SigVerifiableTx)
	if !ok {
		return nil, ErrNotSigVerifiable
	}
	pubkeys, err := sigTx.GetPubKeys()
	if err != nil {
		return nil, err
	}
	if len(pubkeys) != 1 {
		return nil, ErrMultipleSigners
	}
	if pubkeys[0] == nil {
		return nil, ErrInvalidPubkey
	}
	return pubkeys[0], nil
}

// VerifyWalletSignature authenticates a direct-path relay request: the tx must
// be signed by exactly one key whose bech32 address equals walletAddr, and that
// same key must have signed the canonical relay body in the Authorization
// header. Returns the verified signer pubkey. D-S32-CO044-LEADER-DUAL-PATH.
func VerifyWalletSignature(tx sdk.Tx, walletAddr, canonicalBody, sigB64 string) (cryptotypes.PubKey, error) {
	pk, err := ExtractSingleSignerPubKey(tx)
	if err != nil {
		return nil, err
	}
	if sdk.AccAddress(pk.Address()).String() != walletAddr {
		return nil, ErrSignerMismatch
	}
	if err := verifySecp256k1Signature(pk.Bytes(), canonicalBody, sigB64); err != nil {
		return nil, err
	}
	return pk, nil
}

// ValidateDirectMsgs enforces that every message in a directly-signed relay tx
// is relay-allowed and is signed by walletAddr (the leader wallet is the msg
// authority). The chain enforces the actual leader/authority semantics; this is
// the hub-side relay gate.
func ValidateDirectMsgs(tx sdk.Tx, walletAddr string) error {
	msgs := tx.GetMsgs()
	if len(msgs) == 0 {
		return ErrNoMsgs
	}
	for _, msg := range msgs {
		typeURL := sdk.MsgTypeURL(msg)
		if !IsRelayAllowed(typeURL) {
			return fmt.Errorf("%w: %s", ErrDisallowedType, typeURL)
		}
		signer, err := getFieldValue(msg, GranterFieldByMsgType[typeURL])
		if err != nil {
			return err
		}
		if signer != walletAddr {
			return ErrSignerMismatch
		}
	}
	return nil
}

func ExtractInnerGranter(execMsg *authztypes.MsgExec, c codec.Codec) (granter string, err error) {
	if len(execMsg.Msgs) == 0 {
		return "", ErrNoMsgsInExec
	}

	granter = ""
	for i, msgAny := range execMsg.Msgs {
		msg, err := unpackMsgAny(msgAny, c)
		if err != nil {
			return "", fmt.Errorf("resolve message %d: %w", i, err)
		}

		msgGranter, err := extractGranter(msg, msgAny.TypeUrl)
		if err != nil {
			return "", err
		}

		if granter == "" {
			granter = msgGranter
			continue
		}

		if msgGranter != granter {
			return "", ErrGranterMismatch
		}
	}

	return granter, nil
}

func unpackMsgAny(msgAny *codectypes.Any, c codec.Codec) (interface{}, error) {
	var msg interface{}
	if err := c.UnpackAny(msgAny, &msg); err != nil {
		return nil, err
	}
	return msg, nil
}

func extractGranter(msg interface{}, typeURL string) (string, error) {
	field, ok := GranterFieldByMsgType[typeURL]
	if !ok {
		return "", fmt.Errorf("%w: %s", ErrDisallowedType, typeURL)
	}

	granter, err := getFieldValue(msg, field)
	if err != nil {
		return "", err
	}

	return granter, nil
}

func getFieldValue(msg interface{}, field string) (string, error) {
	switch m := msg.(type) {
	case interface{ GetSigner() string }:
		return m.GetSigner(), nil
	}

	return "", fmt.Errorf("message does not have %s field", field)
}