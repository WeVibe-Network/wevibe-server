package relay

import (
	"bytes"
	"testing"

	"github.com/cosmos/cosmos-sdk/codec"
	codectypes "github.com/cosmos/cosmos-sdk/codec/types"
	authztypes "github.com/cosmos/cosmos-sdk/x/authz"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/cosmos/gogoproto/proto"
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
		"/wevibe.org.v1.MsgSetRepTiers",
		"/wevibe.org.v1.MsgUpdateMemberRole",
		"/wevibe.org.v1.MsgRotateEpoch",
	}

	for _, typeURL := range allowed {
		if !IsRelayAllowed(typeURL) {
			t.Errorf("expected %s to be allowed", typeURL)
		}
	}

	disallowed := []string{
		"/wevibe.ledger.v1.MsgFundTreasury",
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
		Signer:      signer,
		OrgId:       "my-org",
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