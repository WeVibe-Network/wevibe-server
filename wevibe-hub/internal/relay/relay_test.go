package relay

import (
	"bytes"
	"encoding/base64"
	"testing"

	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	cryptocodec "github.com/cosmos/cosmos-sdk/crypto/codec"
	"github.com/cosmos/cosmos-sdk/crypto/keys/secp256k1"
	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/tx/signing"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	authztypes "github.com/cosmos/cosmos-sdk/x/authz"
	"github.com/cosmos/gogoproto/proto"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
)

func TestParseCanonicalBody_Valid(t *testing.T) {
	raw := []byte(`WV-RELAY-v1
org_id:my-org
wallet_address:wevibe1abc123
tx_bytes_base64:dGVzdA==`)

	orgID, walletAddr, txBytesB64, err := ParseCanonicalBody(raw)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if orgID != "my-org" {
		t.Errorf("expected org_id 'my-org', got '%s'", orgID)
	}
	if walletAddr != "wevibe1abc123" {
		t.Errorf("expected wallet_address 'wevibe1abc123', got '%s'", walletAddr)
	}
	if txBytesB64 != "dGVzdA==" {
		t.Errorf("expected tx_bytes_base64 'dGVzdA==', got '%s'", txBytesB64)
	}
}

func TestParseCanonicalBody_MissingField(t *testing.T) {
	raw := []byte(`WV-RELAY-v1
org_id:my-org
tx_bytes_base64:dGVzdA==`)

	_, _, _, err := ParseCanonicalBody(raw)
	if err == nil {
		t.Fatal("expected error for missing wallet_address")
	}
	if err != ErrMissingWalletAddr {
		t.Errorf("expected ErrMissingWalletAddr, got %v", err)
	}
}

func TestParseCanonicalBody_WrongHeader(t *testing.T) {
	raw := []byte(`WV-OTHER-v1
org_id:my-org
wallet_address:wevibe1abc123
tx_bytes_base64:dGVzdA==`)

	_, _, _, err := ParseCanonicalBody(raw)
	if err == nil {
		t.Fatal("expected error for wrong header")
	}
	if err != ErrWrongHeader {
		t.Errorf("expected ErrWrongHeader, got %v", err)
	}
}

func TestIsRelayAllowed(t *testing.T) {
	allowed := []string{
		"/wevibe.memory.v1.MsgSubmitCommitment",
		"/wevibe.memory.v1.MsgApproveMemory",
		"/wevibe.memory.v1.MsgReportMemory",
		"/wevibe.serve.v1.MsgSubmitServeBatch",
		"/wevibe.serve.v1.MsgSubmitDenialBatch",
		"/wevibe.org.v1.MsgRegisterOrg",
		"/wevibe.org.v1.MsgAddMember",
		"/wevibe.org.v1.MsgRemoveMember",
		"/wevibe.org.v1.MsgSetOrgConfig",
		"/wevibe.org.v1.MsgUpdateMemberRole",
		"/wevibe.org.v1.MsgRotateEpoch",
	}

	for _, typeURL := range allowed {
		if !IsRelayAllowed(typeURL) {
			t.Errorf("expected %s to be allowed", typeURL)
		}
	}

	disallowed := []string{
		"/wevibe.memory.v1.MsgRejectMemory",
		"/cosmos.authz.v1beta1.MsgGrant",
	}

	for _, typeURL := range disallowed {
		if IsRelayAllowed(typeURL) {
			t.Errorf("expected %s to be disallowed", typeURL)
		}
	}
}

func newAny(msg proto.Message) *codectypes.Any {
	any, _ := codectypes.NewAnyWithValue(msg)
	return any
}

func TestExtractInnerGranter_AllSame(t *testing.T) {
	registry := codectypes.NewInterfaceRegistry()
	authztypes.RegisterInterfaces(registry)
	memorytypes.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)

	signer := "wevibe1abc123"

	msg1 := &memorytypes.MsgSubmitCommitment{
		Signer: signer,
		OrgId:  "my-org",
	}
	msg2 := &memorytypes.MsgApproveMemory{
		Signer: signer,
		OrgId:  "my-org",
	}

	execMsg := &authztypes.MsgExec{
		Msgs: []*codectypes.Any{
			newAny(msg1),
			newAny(msg2),
		},
	}

	granter, err := ExtractInnerGranter(execMsg, cdc)
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if granter != signer {
		t.Errorf("expected granter '%s', got '%s'", signer, granter)
	}
}

func TestExtractInnerGranter_Mismatch(t *testing.T) {
	registry := codectypes.NewInterfaceRegistry()
	authztypes.RegisterInterfaces(registry)
	memorytypes.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)

	msg1 := &memorytypes.MsgSubmitCommitment{
		Signer: "wevibe1abc123",
		OrgId:  "my-org",
	}
	msg2 := &memorytypes.MsgSubmitCommitment{
		Signer: "wevibe1xyz789",
		OrgId:  "my-org",
	}

	execMsg := &authztypes.MsgExec{
		Msgs: []*codectypes.Any{
			newAny(msg1),
			newAny(msg2),
		},
	}

	_, err := ExtractInnerGranter(execMsg, cdc)
	if err == nil {
		t.Fatal("expected error for mismatched granters")
	}
	if err != ErrGranterMismatch {
		t.Errorf("expected ErrGranterMismatch, got %v", err)
	}
}

func TestExtractInnerGranter_DisallowedType(t *testing.T) {
	registry := codectypes.NewInterfaceRegistry()
	authztypes.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)

	msg := &authztypes.MsgGrant{
		Granter: "wevibe1abc123",
	}

	execMsg := &authztypes.MsgExec{
		Msgs: []*codectypes.Any{
			newAny(msg),
		},
	}

	_, err := ExtractInnerGranter(execMsg, cdc)
	if err == nil {
		t.Fatal("expected error for disallowed type")
	}
	if !bytes.Contains([]byte(err.Error()), []byte("not allowed")) {
		t.Errorf("expected 'not allowed' error, got %v", err)
	}
}

// ── Direct (non-delegate) leader-signing path — D-S32-CO044-LEADER-DUAL-PATH ──

func init() {
	sdk.GetConfig().SetBech32PrefixForAccount("wevibe", "wevibepub")
}

// buildDirectTx constructs a single-signer tx carrying msg, with the signer
// pubkey embedded (so GetPubKeys resolves), as a directly-signed leader tx.
func buildDirectTx(t *testing.T, priv *secp256k1.PrivKey, msg sdk.Msg) sdk.Tx {
	t.Helper()
	registry := codectypes.NewInterfaceRegistry()
	cryptocodec.RegisterInterfaces(registry)
	memorytypes.RegisterInterfaces(registry)
	cdc := codec.NewProtoCodec(registry)
	cfg := authtx.NewTxConfig(cdc, authtx.DefaultSignModes)

	b := cfg.NewTxBuilder()
	if err := b.SetMsgs(msg); err != nil {
		t.Fatalf("set msgs: %v", err)
	}
	if err := b.SetSignatures(signing.SignatureV2{
		PubKey: priv.PubKey(),
		Data: &signing.SingleSignatureData{
			SignMode:  signing.SignMode_SIGN_MODE_DIRECT,
			Signature: nil,
		},
		Sequence: 0,
	}); err != nil {
		t.Fatalf("set signatures: %v", err)
	}
	return b.GetTx()
}

func signBody(t *testing.T, priv *secp256k1.PrivKey, body string) string {
	t.Helper()
	sig, err := priv.Sign([]byte(body))
	if err != nil {
		t.Fatalf("sign body: %v", err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

func TestVerifyWalletSignature_Valid(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	walletAddr := sdk.AccAddress(priv.PubKey().Address()).String()
	body := "WV-RELAY-v1\norg_id:o\nwallet_address:" + walletAddr + "\ntx_bytes_base64:AA=="

	tx := buildDirectTx(t, priv, &memorytypes.MsgApproveMemory{Signer: walletAddr, OrgId: "o"})
	sigB64 := signBody(t, priv, body)

	pk, err := VerifyWalletSignature(tx, walletAddr, body, sigB64)
	if err != nil {
		t.Fatalf("expected valid wallet signature, got %v", err)
	}
	if sdk.AccAddress(pk.Address()).String() != walletAddr {
		t.Errorf("returned pubkey address mismatch")
	}
}

func TestVerifyWalletSignature_AddressMismatch(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	other := sdk.AccAddress(secp256k1.GenPrivKey().PubKey().Address()).String()
	body := "WV-RELAY-v1\norg_id:o\nwallet_address:" + other + "\ntx_bytes_base64:AA=="

	tx := buildDirectTx(t, priv, &memorytypes.MsgApproveMemory{Signer: other, OrgId: "o"})
	sigB64 := signBody(t, priv, body)

	if _, err := VerifyWalletSignature(tx, other, body, sigB64); err != ErrSignerMismatch {
		t.Fatalf("expected ErrSignerMismatch, got %v", err)
	}
}

func TestVerifyWalletSignature_BadSig(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	walletAddr := sdk.AccAddress(priv.PubKey().Address()).String()
	body := "WV-RELAY-v1\norg_id:o\nwallet_address:" + walletAddr + "\ntx_bytes_base64:AA=="

	tx := buildDirectTx(t, priv, &memorytypes.MsgApproveMemory{Signer: walletAddr, OrgId: "o"})
	// Sign a different body → signature will not verify over `body`.
	sigB64 := signBody(t, priv, body+"tampered")

	if _, err := VerifyWalletSignature(tx, walletAddr, body, sigB64); err != ErrSignatureVerifyFail {
		t.Fatalf("expected ErrSignatureVerifyFail, got %v", err)
	}
}

func TestValidateDirectMsgs_Allowed(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	walletAddr := sdk.AccAddress(priv.PubKey().Address()).String()
	tx := buildDirectTx(t, priv, &memorytypes.MsgApproveMemory{Signer: walletAddr, OrgId: "o"})

	if err := ValidateDirectMsgs(tx, walletAddr); err != nil {
		t.Fatalf("expected allowed msg to pass, got %v", err)
	}
}

func TestValidateDirectMsgs_SignerMismatch(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	walletAddr := sdk.AccAddress(priv.PubKey().Address()).String()
	// msg signer is someone else
	tx := buildDirectTx(t, priv, &memorytypes.MsgApproveMemory{Signer: "wevibe1other", OrgId: "o"})

	if err := ValidateDirectMsgs(tx, walletAddr); err != ErrSignerMismatch {
		t.Fatalf("expected ErrSignerMismatch, got %v", err)
	}
}

func TestValidateDirectMsgs_DisallowedType(t *testing.T) {
	priv := secp256k1.GenPrivKey()
	walletAddr := sdk.AccAddress(priv.PubKey().Address()).String()
	// MsgExec is not in the relay allow-list as a top-level direct msg
	tx := buildDirectTx(t, priv, &authztypes.MsgExec{Grantee: walletAddr})

	err := ValidateDirectMsgs(tx, walletAddr)
	if err == nil || !bytes.Contains([]byte(err.Error()), []byte("not allowed")) {
		t.Fatalf("expected 'not allowed' error, got %v", err)
	}
}
