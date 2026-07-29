package chain

import (
	"testing"
)

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
	if len(msg.Serves[0].ServeKeyPubkey) != 32 {
		t.Fatalf("unexpected serve key pubkey length: got %d want %d", len(msg.Serves[0].ServeKeyPubkey), 32)
	}
	if len(msg.Serves[0].ServeSig) != 64 {
		t.Fatalf("unexpected serve sig length: got %d want %d", len(msg.Serves[0].ServeSig), 64)
	}
}

func TestBuildServeBatchMsg_AllowsEmptyMatchedKeywords(t *testing.T) {
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
	if err != nil {
		t.Fatalf("BuildServeBatchMsg returned error for metadata-only matched keywords: %v", err)
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

func TestBuildEventBatchMsg_MapsOutcome(t *testing.T) {
	client := &GrpcClient{}
	msg, err := client.BuildEventBatchMsg("org-1", []OutcomeEventInput{{
		EpochID:           12,
		MemoryContentHash: hexOf(bytes32(0x51)),
		SignerPubkey:      hexOf(bytes32(0x52)),
		Nonce:             "01",
		Signature:         hexOf(bytes64(0x53)),
		EpisodeRef:        "aa",
		Worked:            true,
		EvidenceRef:       "bb",
	}})
	if err != nil {
		t.Fatalf("BuildEventBatchMsg returned error: %v", err)
	}
	if msg.OrgId != "org-1" || msg.Epoch != 12 {
		t.Fatalf("unexpected batch identity: org=%s epoch=%d", msg.OrgId, msg.Epoch)
	}
	if len(msg.Events) != 1 {
		t.Fatalf("unexpected event count: %d", len(msg.Events))
	}
	if msg.Events[0].GetOutcome() == nil || !msg.Events[0].GetOutcome().Worked {
		t.Fatalf("missing outcome body")
	}
}

func TestBuildEventBatchMsg_RejectsInvalidHex(t *testing.T) {
	client := &GrpcClient{}
	_, err := client.BuildEventBatchMsg("org-1", []OutcomeEventInput{{
		EpochID:           12,
		MemoryContentHash: "not-hex",
		SignerPubkey:      hexOf(bytes32(0x52)),
		Nonce:             "01",
		Signature:         hexOf(bytes64(0x53)),
		EpisodeRef:        "aa",
		Worked:            true,
		EvidenceRef:       "bb",
	}})
	if err == nil {
		t.Fatalf("expected invalid hex error")
	}
}

func hexOf(b []byte) string {
	const chars = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, v := range b {
		out[i*2] = chars[v>>4]
		out[i*2+1] = chars[v&0x0f]
	}
	return string(out)
}

func bytes64(b byte) []byte {
	out := make([]byte, 64)
	for i := range out {
		out[i] = b
	}
	return out
}
