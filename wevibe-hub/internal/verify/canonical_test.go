package verify

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

func TestCreateOrgMessage_Deterministic(t *testing.T) {
	msg := CreateOrgMessage(
		"aabbccdd",
		"11223344",
		"Test Org",
		"test.example.com",
		"enc_env_base64_data",
		"srch_env_base64_data",
		"mod_env_base64_data",
		"pk_mod_hex_value",
		protocol.FeeModel{},
	)

	result := string(msg)

	if result[:24] != "wevibe.create_org.v1\ndom" {
		t.Fatalf("unexpected prefix: %q", result[:24])
	}

	lines := splitLines(result)
	if len(lines) != 10 {
		t.Fatalf("expected 10 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "wevibe.create_org.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "domain:test.example.com" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "enc_envelope:enc_env_base64_data" {
		t.Errorf("line 2: %q", lines[2])
	}
	emptyHash := sha256Hex([]byte("{}"))
	if lines[3] != "fee_model_hash:"+emptyHash {
		t.Errorf("line 3: %q, expected fee_model_hash:%s", lines[3], emptyHash)
	}
	if lines[4] != "leader_pubkey:aabbccdd" {
		t.Errorf("line 4: %q", lines[4])
	}
	if lines[5] != "leader_x25519_pubkey:11223344" {
		t.Errorf("line 5: %q", lines[5])
	}
	if lines[6] != "mod_envelope:mod_env_base64_data" {
		t.Errorf("line 6: %q", lines[6])
	}
	if lines[7] != "org_name:Test Org" {
		t.Errorf("line 7: %q", lines[7])
	}
	if lines[8] != "pk_mod:pk_mod_hex_value" {
		t.Errorf("line 8: %q", lines[8])
	}
	if lines[9] != "search_envelope:srch_env_base64_data" {
		t.Errorf("line 9: %q", lines[9])
	}
}

func TestCreateOrgMessage_WithFeeModel(t *testing.T) {
	feeModel := protocol.FeeModel{Tier: "free", MonthlyCredits: 100}
	msg := CreateOrgMessage("pub1", "x1", "Org", "d.com", "enc", "srch", "mod", "pk_mod", feeModel)

	lines := splitLines(string(msg))
	expectedJSON := `{"tier":"free","monthly_credits":100}`
	expectedHash := sha256Hex([]byte(expectedJSON))
	if lines[3] != "fee_model_hash:"+expectedHash {
		t.Errorf("fee_model_hash mismatch: got %q, expected fee_model_hash:%s", lines[3], expectedHash)
	}
}

func TestCreateOrgMessage_DeterministicRepeated(t *testing.T) {
	msg1 := CreateOrgMessage("p", "x", "n", "d", "e", "s", "m", "pk", protocol.FeeModel{})
	msg2 := CreateOrgMessage("p", "x", "n", "d", "e", "s", "m", "pk", protocol.FeeModel{})
	if string(msg1) != string(msg2) {
		t.Fatal("CreateOrgMessage is not deterministic")
	}
}

func TestInviteMemberMessage_Deterministic(t *testing.T) {
	msg := InviteMemberMessage(
		"org-test-1",
		"invitee_pubkey_hex",
		"invitee_x25519_hex",
		"member",
		"leader_pubkey_hex",
		"enc_env_base64_data",
		"srch_env_base64_data",
		"mod_envelope_data",
		false,
		false,
	)

	lines := splitLines(string(msg))
	if len(lines) != 11 {
		t.Fatalf("expected 11 lines, got %d", len(lines))
	}
	if lines[0] != "wevibe.invite_member.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "can_contribute:false" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "can_moderate:false" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "enc_envelope:enc_env_base64_data" {
		t.Errorf("line 3: %q", lines[3])
	}
	if lines[4] != "mod_envelope:mod_envelope_data" {
		t.Errorf("line 4: %q", lines[4])
	}
	if lines[5] != "org_id:org-test-1" {
		t.Errorf("line 5: %q", lines[5])
	}
	if lines[6] != "pubkey:invitee_pubkey_hex" {
		t.Errorf("line 6: %q", lines[6])
	}
	if lines[7] != "role:member" {
		t.Errorf("line 7: %q", lines[7])
	}
	if lines[8] != "search_envelope:srch_env_base64_data" {
		t.Errorf("line 8: %q", lines[8])
	}
	if lines[9] != "signed_by:leader_pubkey_hex" {
		t.Errorf("line 9: %q", lines[9])
	}
	if lines[10] != "x25519_pubkey:invitee_x25519_hex" {
		t.Errorf("line 10: %q", lines[10])
	}
}

func TestRotateEpochMessage_Deterministic(t *testing.T) {
	modEnv := "mod_data"
	envs := []protocol.MemberEnvelopePair{
		{Pubkey: "charlie", EncEnvelope: "enc_c", SearchEnvelope: "srch_c", ModEnvelope: nil},
		{Pubkey: "alice", EncEnvelope: "enc_a", SearchEnvelope: "srch_a", ModEnvelope: &modEnv},
		{Pubkey: "bob", EncEnvelope: "enc_b", SearchEnvelope: "srch_b", ModEnvelope: nil},
	}

	msg := RotateEpochMessage("org-1", "new_pk_mod_hex", "leader_hex", envs)
	lines := splitLines(string(msg))

	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d", len(lines))
	}
	if lines[0] != "wevibe.rotate_epoch.v1" {
		t.Errorf("line 0: %q", lines[0])
	}

	inner := "enc_envelope:enc_a\nmod_envelope:mod_data\npubkey:alice\nsearch_envelope:srch_a" +
		"\n--\n" +
		"enc_envelope:enc_b\nmod_envelope:\npubkey:bob\nsearch_envelope:srch_b" +
		"\n--\n" +
		"enc_envelope:enc_c\nmod_envelope:\npubkey:charlie\nsearch_envelope:srch_c"
	expectedHash := sha256Hex([]byte(inner))

	if lines[1] != "envelopes_hash:"+expectedHash {
		t.Errorf("envelopes_hash mismatch:\ngot:  %q\nwant: envelopes_hash:%s", lines[1], expectedHash)
	}
	if lines[2] != "new_pk_mod:new_pk_mod_hex" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "org_id:org-1" {
		t.Errorf("line 3: %q", lines[3])
	}
	if lines[4] != "signed_by:leader_hex" {
		t.Errorf("line 4: %q", lines[4])
	}
}

func TestRotateEpochMessage_OrderIndependent(t *testing.T) {
	envs1 := []protocol.MemberEnvelopePair{
		{Pubkey: "bob", EncEnvelope: "enc_b", SearchEnvelope: "srch_b"},
		{Pubkey: "alice", EncEnvelope: "enc_a", SearchEnvelope: "srch_a"},
	}
	envs2 := []protocol.MemberEnvelopePair{
		{Pubkey: "alice", EncEnvelope: "enc_a", SearchEnvelope: "srch_a"},
		{Pubkey: "bob", EncEnvelope: "enc_b", SearchEnvelope: "srch_b"},
	}

	msg1 := RotateEpochMessage("o", "p", "s", envs1)
	msg2 := RotateEpochMessage("o", "p", "s", envs2)

	if string(msg1) != string(msg2) {
		t.Fatal("RotateEpochMessage should be order-independent on envelopes input")
	}
}

func TestRemoveMemberMessage_Deterministic(t *testing.T) {
	msg := RemoveMemberMessage("org-test-1", "member_pubkey_hex", "leader_pubkey_hex")

	lines := splitLines(string(msg))
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d", len(lines))
	}
	if lines[0] != "wevibe.remove_member.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "org_id:org-test-1" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "pubkey:member_pubkey_hex" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "signed_by:leader_pubkey_hex" {
		t.Errorf("line 3: %q", lines[3])
	}
}

func TestSubmitMemoryMessage_Deterministic(t *testing.T) {
	msg := SubmitMemoryMessage(
		"org-test-1",
		3,
		"abc123def456",
		"contributor_pubkey_hex",
		protocol.MemoryTypeMemory,
		"ciphertext_hash_hex",
		"plaintext_hash_hex",
		"salt_hex",
		"wrapped_dek_hash_hex",
	)

	lines := splitLines(string(msg))
	if len(lines) != 10 {
		t.Fatalf("expected 10 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "wevibe.submit_memory.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "ciphertext_hash:ciphertext_hash_hex" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "contributor_pubkey:contributor_pubkey_hex" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "epoch_id:3" {
		t.Errorf("line 3: %q", lines[3])
	}
	if lines[4] != "memory_type:memory" {
		t.Errorf("line 4: %q", lines[4])
	}
	if lines[5] != "org_id:org-test-1" {
		t.Errorf("line 5: %q", lines[5])
	}
	if lines[6] != "plaintext_hash:plaintext_hash_hex" {
		t.Errorf("line 6: %q", lines[6])
	}
	if lines[7] != "salt:salt_hex" {
		t.Errorf("line 7: %q", lines[7])
	}
	if lines[8] != "submission_hash:abc123def456" {
		t.Errorf("line 8: %q", lines[8])
	}
	if lines[9] != "wrapped_dek_hash:wrapped_dek_hash_hex" {
		t.Errorf("line 9: %q", lines[9])
	}
}

func TestSubmitMemoryMessage_Vector1Hex(t *testing.T) {
	msg := SubmitMemoryMessage(
		"org-test-001",
		42,
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		protocol.MemoryTypeMemory,
		"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	)

	expectedHex := manualSubmitMemoryHex(
		"org-test-001",
		42,
		"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		protocol.MemoryTypeMemory,
		"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	)
	gotHex := hex.EncodeToString(msg)
	if gotHex != expectedHex {
		t.Fatalf("hex mismatch:\n  got:  %s\n  want: %s", gotHex, expectedHex)
	}
}

func TestCanonicalBodyCrossLanguageConformance(t *testing.T) {
	tests := []struct {
		name              string
		orgID             string
		epochID           int
		submissionHash    string
		contributorPubkey string
		memoryType        string
		ciphertextHash    string
		plaintextHash     string
		salt              string
		wrappedDekHash    string
	}{
		{
			name:              "vector-1-standard",
			orgID:             "org-test-001",
			epochID:           42,
			submissionHash:    strings.Repeat("a", 64),
			contributorPubkey: strings.Repeat("b", 64),
			memoryType:        protocol.MemoryTypeMemory,
			ciphertextHash:    strings.Repeat("c", 64),
			plaintextHash:     strings.Repeat("d", 64),
			salt:              strings.Repeat("e", 64),
			wrappedDekHash:    strings.Repeat("f", 64),
		},
		{
			name:              "vector-2-zero-epoch",
			orgID:             "org-edge-002",
			epochID:           0,
			submissionHash:    strings.Repeat("1", 64),
			contributorPubkey: strings.Repeat("2", 64),
			memoryType:        protocol.MemoryTypeMemory,
			ciphertextHash:    strings.Repeat("3", 64),
			plaintextHash:     strings.Repeat("4", 64),
			salt:              strings.Repeat("5", 64),
			wrappedDekHash:    strings.Repeat("6", 64),
		},
		{
			name:              "vector-3-special-org-id",
			orgID:             "org_with-dashes_and.dots",
			epochID:           999999,
			submissionHash:    strings.Repeat("ab", 32),
			contributorPubkey: strings.Repeat("cd", 32),
			memoryType:        protocol.MemoryTypeMemory,
			ciphertextHash:    strings.Repeat("ef", 32),
			plaintextHash:     strings.Repeat("01", 32),
			salt:              strings.Repeat("23", 32),
			wrappedDekHash:    strings.Repeat("45", 32),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := SubmitMemoryMessage(
				tt.orgID,
				tt.epochID,
				tt.submissionHash,
				tt.contributorPubkey,
				tt.memoryType,
				tt.ciphertextHash,
				tt.plaintextHash,
				tt.salt,
				tt.wrappedDekHash,
			)
			gotHex := hex.EncodeToString(got)
			expectedHex := manualSubmitMemoryHex(
				tt.orgID,
				tt.epochID,
				tt.submissionHash,
				tt.contributorPubkey,
				tt.memoryType,
				tt.ciphertextHash,
				tt.plaintextHash,
				tt.salt,
				tt.wrappedDekHash,
			)
			if gotHex != expectedHex {
				t.Fatalf("canonical body mismatch:\n  got:  %s\n  want: %s", gotHex, expectedHex)
			}
		})
	}
}

func TestApproveSubmissionMessage_Deterministic(t *testing.T) {
	msg := ApproveSubmissionMessage(
		"org-test-1",
		"abc123def456",
		int32(0),
		"cid-approved-1",
		"umbral_capsule_hex",
		"umbral_ciphertext_hex",
		protocol.MemoryTypeMemory,
		"moderator_pubkey_hex",
		[]protocol.KeywordWithWeight{
			{Keyword: "token_b", Weight: 0.5},
			{Keyword: "token_a", Weight: 0.3},
			{Keyword: "token_c", Weight: 0.2},
		},
	)

	lines := splitLines(string(msg))
	if len(lines) != 10 {
		t.Fatalf("expected 10 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "wevibe.approve_submission.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "approved_cid:cid-approved-1" {
		t.Errorf("line 1: %q", lines[1])
	}

	if lines[3] != "epoch_id:0" {
		t.Errorf("line 3: %q", lines[3])
	}
	if lines[4] != "memory_type:memory" {
		t.Errorf("line 4: %q", lines[4])
	}
	if lines[5] != "org_id:org-test-1" {
		t.Errorf("line 5: %q", lines[5])
	}
	if lines[6] != "signed_by:moderator_pubkey_hex" {
		t.Errorf("line 6: %q", lines[6])
	}
	if lines[7] != "submission_hash:abc123def456" {
		t.Errorf("line 7: %q", lines[7])
	}
	if lines[8] != "umbral_capsule:umbral_capsule_hex" {
		t.Errorf("line 8: %q", lines[8])
	}
	if lines[9] != "umbral_ciphertext:umbral_ciphertext_hex" {
		t.Errorf("line 9: %q", lines[9])
	}
}

func TestApproveSubmissionMessage_KeywordsOrderIndependent(t *testing.T) {
	msg1 := ApproveSubmissionMessage("o", "h", 1, "c", "cap", "ct", protocol.MemoryTypeMemory, "s", []protocol.KeywordWithWeight{
		{Keyword: "b", Weight: 0.5}, {Keyword: "a", Weight: 0.3}, {Keyword: "c", Weight: 0.2},
	})
	msg2 := ApproveSubmissionMessage("o", "h", 1, "c", "cap", "ct", protocol.MemoryTypeMemory, "s", []protocol.KeywordWithWeight{
		{Keyword: "c", Weight: 0.2}, {Keyword: "a", Weight: 0.3}, {Keyword: "b", Weight: 0.5},
	})
	if string(msg1) != string(msg2) {
		t.Fatal("ApproveSubmissionMessage should be order-independent on keywords")
	}
}

func TestApproveSubmissionMessage_EmptyKeywords(t *testing.T) {
	msg := ApproveSubmissionMessage("o", "h", 0, "c", "cap", "ct", protocol.MemoryTypeMemory, "s", []protocol.KeywordWithWeight{})
	lines := splitLines(string(msg))
	if len(lines) != 10 {
		t.Fatalf("expected 10 lines, got %d: %v", len(lines), lines)
	}
}

func TestDenySubmissionMessage_Deterministic(t *testing.T) {
	msg := DenySubmissionMessage(
		"org-test-1",
		"abc123def456",
		"contains credentials",
		"moderator_pubkey_hex",
	)

	lines := splitLines(string(msg))
	if len(lines) != 5 {
		t.Fatalf("expected 5 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "wevibe.deny_submission.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "org_id:org-test-1" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "reason:contains credentials" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "signed_by:moderator_pubkey_hex" {
		t.Errorf("line 3: %q", lines[3])
	}
	if lines[4] != "submission_hash:abc123def456" {
		t.Errorf("line 4: %q", lines[4])
	}
}

func TestDenySubmissionMessage_DeterministicRepeated(t *testing.T) {
	msg1 := DenySubmissionMessage("o", "h", "r", "s")
	msg2 := DenySubmissionMessage("o", "h", "r", "s")
	if string(msg1) != string(msg2) {
		t.Fatal("DenySubmissionMessage is not deterministic")
	}
}

func TestBanContributorMessage_Deterministic(t *testing.T) {
	msg := BanContributorMessage(
		"org-test-1",
		"contributor_pubkey_hex",
		"leader_pubkey_hex",
	)

	lines := splitLines(string(msg))
	if len(lines) != 4 {
		t.Fatalf("expected 4 lines, got %d: %v", len(lines), lines)
	}
	if lines[0] != "wevibe.ban_contributor.v1" {
		t.Errorf("line 0: %q", lines[0])
	}
	if lines[1] != "org_id:org-test-1" {
		t.Errorf("line 1: %q", lines[1])
	}
	if lines[2] != "contributor_pubkey:contributor_pubkey_hex" {
		t.Errorf("line 2: %q", lines[2])
	}
	if lines[3] != "signed_by:leader_pubkey_hex" {
		t.Errorf("line 3: %q", lines[3])
	}
}

func TestKeywordsHash_EmptySlice(t *testing.T) {
	h := keywordsHash([]protocol.KeywordWithWeight{})
	expected := sha256Hex([]byte(""))
	if h != expected {
		t.Errorf("empty keywords hash: got %s, want %s", h, expected)
	}
}

func TestKeywordsHash_SingleKeyword(t *testing.T) {
	h := keywordsHash([]protocol.KeywordWithWeight{{Keyword: "nginx", Weight: 1.0}})
	expected := sha256Hex([]byte("nginx:1.000000"))
	if h != expected {
		t.Errorf("single keyword hash: got %s, want %s", h, expected)
	}
}

func TestFeeModelHash_EmptyIsBraces(t *testing.T) {
	h1 := feeModelHash(protocol.FeeModel{})
	expected := sha256Hex([]byte("{}"))
	if h1 != expected {
		t.Errorf("expected SHA-256 of '{}': got %s, want %s", h1, expected)
	}
}

func TestEnvelopesHash_EmptySlice(t *testing.T) {
	h := envelopesHash(nil)
	expected := sha256Hex([]byte(""))
	if h != expected {
		t.Errorf("empty envelopes hash: got %s, want %s", h, expected)
	}
}

func manualSubmitMemoryHex(orgID string, epochID int, submissionHash, contributorPubkey, memoryType, ciphertextHash, plaintextHash, salt, wrappedDekHash string) string {
	body := strings.Join([]string{
		"wevibe.submit_memory.v1",
		"ciphertext_hash:" + ciphertextHash,
		"contributor_pubkey:" + contributorPubkey,
		"epoch_id:" + strconv.Itoa(epochID),
		"memory_type:" + memoryType,
		"org_id:" + orgID,
		"plaintext_hash:" + plaintextHash,
		"salt:" + salt,
		"submission_hash:" + submissionHash,
		"wrapped_dek_hash:" + wrappedDekHash,
	}, "\n")

	return hex.EncodeToString([]byte(body))
}

func splitLines(s string) []string {
	result := []string{}
	current := ""
	for _, c := range s {
		if c == '\n' {
			result = append(result, current)
			current = ""
		} else {
			current += string(c)
		}
	}
	if current != "" {
		result = append(result, current)
	}
	return result
}

func sha256Hex(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

func TestFeeModelHash_CrossLanguageVectors(t *testing.T) {
	data, err := os.ReadFile("../../../../wevibe-sdk/protocol/test_vectors/fee_model_hash.json")
	if err != nil {
		t.Skipf("test vectors not found: %v", err)
	}

	var doc struct {
		Vectors []struct {
			Name      string             `json:"name"`
			Input     *protocol.FeeModel `json:"input"`
			Canonical string             `json:"canonical"`
			SHA256Hex string             `json:"sha256_hex"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}

	for _, v := range doc.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			var fm protocol.FeeModel
			if v.Input != nil {
				fm = *v.Input
			}
			got := feeModelHash(fm)
			if got != v.SHA256Hex {
				t.Errorf("hash mismatch for %s:\n  got:      %s\n  expected: %s\n  canonical: %s",
					v.Name, got, v.SHA256Hex, v.Canonical)
			}
		})
	}
}
