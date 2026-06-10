package chain

import (
	"testing"

	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
)

func TestBuildSubmitCommitmentMsg_IncludesContributorWallet(t *testing.T) {
	mem := BatchMemory{
		ContentHash:       bytes32(0x11),
		ContributorID:     "contrib-1",
		ContributorWallet: "wevibe1contributorwallet",
		Keywords: []*memorytypes.KeywordWeight{{
			Keyword: "alpha",
			Weight:  "1.0",
		}},
	}

	msg := buildSubmitCommitmentMsg("wevibe1submitter", "org-1", mem, memorytypes.MemoryType_MEMORY_TYPE_MEMORY)
	if msg.ContributorWallet != mem.ContributorWallet {
		t.Fatalf("contributor wallet mismatch: got %q want %q", msg.ContributorWallet, mem.ContributorWallet)
	}
	if msg.ContributorId != mem.ContributorID {
		t.Fatalf("contributor id mismatch: got %q want %q", msg.ContributorId, mem.ContributorID)
	}
}

func bytes32(b byte) []byte {
	out := make([]byte, 32)
	for i := range out {
		out[i] = b
	}
	return out
}

func TestBuildServeBatchMsg_MapsEntries(t *testing.T) {
	client := &GrpcClient{}
	entries := []ServeEntryInput{{
		MemoryContentHash: bytes32(0x11),
		ServeKeyPubkey:    bytes32(0x12),
		ServeSig:          bytes64(0x13),
		Nonce:             []byte{0x01},
		ContributorID:     "contributor-1",
		ContributorWallet: "wevibe1wallet",
		ModelID:           "model-1",
		TurnCount:         3,
		MatchedKeywords:   []string{"alpha", "beta"},
	}}

	msg, err := client.BuildServeBatchMsg("org-1", 7, entries)
	if err != nil {
		t.Fatalf("BuildServeBatchMsg returned error: %v", err)
	}
	if msg.OrgId != "org-1" {
		t.Fatalf("unexpected org id: got %q want %q", msg.OrgId, "org-1")
	}
	if msg.Epoch != 7 {
		t.Fatalf("unexpected epoch: got %d want %d", msg.Epoch, 7)
	}
	if len(msg.Serves) != 1 {
		t.Fatalf("unexpected serve entry count: got %d want %d", len(msg.Serves), 1)
	}
	if msg.Serves[0].ContributorWallet != "wevibe1wallet" {
		t.Fatalf("unexpected contributor wallet: got %q", msg.Serves[0].ContributorWallet)
	}
	if len(msg.Serves[0].MatchedKeywords) != 2 {
		t.Fatalf("unexpected matched keyword count: got %d want %d", len(msg.Serves[0].MatchedKeywords), 2)
	}
	if len(msg.Serves[0].ServeKeyPubkey) != 32 {
		t.Fatalf("unexpected serve key pubkey length: got %d want %d", len(msg.Serves[0].ServeKeyPubkey), 32)
	}
	if len(msg.Serves[0].ServeSig) != 64 {
		t.Fatalf("unexpected serve sig length: got %d want %d", len(msg.Serves[0].ServeSig), 64)
	}
}

func TestBuildServeBatchMsg_RejectsEmptyMatchedKeywords(t *testing.T) {
	client := &GrpcClient{}
	_, err := client.BuildServeBatchMsg("org-1", 9, []ServeEntryInput{{
		MemoryContentHash: bytes32(0x11),
		ServeKeyPubkey:    bytes32(0x12),
		ServeSig:          bytes64(0x13),
		Nonce:             []byte{0x01},
		ContributorID:     "contributor-1",
		ContributorWallet: "wevibe1wallet",
		ModelID:           "model-1",
		TurnCount:         3,
	}})
	if err == nil {
		t.Fatalf("expected validation error for empty matched keywords")
	}
}

func TestBuildDenialBatchMsg_MapsEntries(t *testing.T) {
	client := &GrpcClient{}
	entries := []DenialEntryInput{{
		MemoryHash:       bytes32(0x31),
		Reason:           "spam",
		ServeKeyPubkey:   bytes32(0x41),
		ServeSig:         bytes64(0x42),
		ServeFingerprint: bytes32(0x43),
		Nonce:            []byte{0xaa, 0xbb},
	}}

	msg, err := client.BuildDenialBatchMsg("org-7", 11, entries)
	if err != nil {
		t.Fatalf("BuildDenialBatchMsg returned error: %v", err)
	}
	if msg.OrgId != "org-7" {
		t.Fatalf("unexpected org id: got %q want %q", msg.OrgId, "org-7")
	}
	if msg.Epoch != 11 {
		t.Fatalf("unexpected epoch: got %d want %d", msg.Epoch, 11)
	}
	if len(msg.Entries) != 1 {
		t.Fatalf("unexpected denial entry count: got %d want %d", len(msg.Entries), 1)
	}
	if msg.Entries[0].Reason != "spam" {
		t.Fatalf("unexpected denial reason: got %q want %q", msg.Entries[0].Reason, "spam")
	}
	if len(msg.Entries[0].ServeFingerprint) != 32 {
		t.Fatalf("unexpected serve fingerprint length: got %d want %d", len(msg.Entries[0].ServeFingerprint), 32)
	}
}

func bytes64(b byte) []byte {
	out := make([]byte, 64)
	for i := range out {
		out[i] = b
	}
	return out
}
