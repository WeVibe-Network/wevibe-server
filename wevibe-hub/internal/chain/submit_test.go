package chain

import (
	"strings"
	"testing"

	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
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
	serveRef := hexOf(bytes32(0x54))
	msg, err := client.BuildEventBatchMsg("org-1", []OutcomeEventInput{{
		EpochID:           12,
		MemoryContentHash: hexOf(bytes32(0x51)),
		SignerPubkey:      hexOf(bytes32(0x52)),
		Nonce:             "01",
		Signature:         hexOf(bytes64(0x53)),
		EpisodeRef:        "aa",
		ServeRef:          serveRef,
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
	if got := hexOf(msg.Events[0].GetOutcome().ServeRef); got != serveRef {
		t.Fatalf("unexpected serve ref: got %s want %s", got, serveRef)
	}
}

func TestBuildEventBatchMsg_FingerprintSelfCheckFailsWithServeRefDrift(t *testing.T) {
	client := &GrpcClient{}
	input := validOutcomeEventInputForSubmitTest()
	input.Fingerprint = fingerprintForOutcomeInput(t, "org-1", input)
	input.ServeRef = hexOf(bytes32(0x55))

	_, err := client.BuildEventBatchMsg("org-1", []OutcomeEventInput{input})
	if err == nil || !strings.Contains(err.Error(), "fingerprint mismatch") {
		t.Fatalf("BuildEventBatchMsg error = %v, want fingerprint mismatch", err)
	}
}

func TestBuildEventBatchMsg_RejectsInvalidServeRef(t *testing.T) {
	client := &GrpcClient{}
	tests := []struct {
		name     string
		serveRef string
	}{
		{name: "missing", serveRef: ""},
		{name: "31 bytes", serveRef: hexOf(bytes32(0x54))[:62]},
		{name: "33 bytes", serveRef: hexOf(append(bytes32(0x54), 0x54))},
		{name: "non hex", serveRef: strings.Repeat("zz", 32)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			input := validOutcomeEventInputForSubmitTest()
			input.ServeRef = tt.serveRef

			_, err := client.BuildEventBatchMsg("org-1", []OutcomeEventInput{input})
			if err == nil {
				t.Fatalf("expected invalid serve_ref error")
			}
		})
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

func validOutcomeEventInputForSubmitTest() OutcomeEventInput {
	return OutcomeEventInput{
		EpochID:           12,
		MemoryContentHash: hexOf(bytes32(0x51)),
		SignerPubkey:      hexOf(bytes32(0x52)),
		Nonce:             "01",
		Signature:         hexOf(bytes64(0x53)),
		EpisodeRef:        "aa",
		ServeRef:          hexOf(bytes32(0x54)),
		Worked:            true,
		EvidenceRef:       "bb",
	}
}

func fingerprintForOutcomeInput(t *testing.T, orgID string, input OutcomeEventInput) string {
	t.Helper()
	memoryHash, err := decodeHexField(input.MemoryContentHash, "memory_content_hash", 32)
	if err != nil {
		t.Fatalf("decode memory_content_hash: %v", err)
	}
	signerPubkey, err := decodeHexField(input.SignerPubkey, "signer_pubkey", 32)
	if err != nil {
		t.Fatalf("decode signer_pubkey: %v", err)
	}
	nonce, err := decodeHexField(input.Nonce, "nonce", 0)
	if err != nil {
		t.Fatalf("decode nonce: %v", err)
	}
	episodeRef, err := decodeHexField(input.EpisodeRef, "episode_ref", 0)
	if err != nil {
		t.Fatalf("decode episode_ref: %v", err)
	}
	serveRef, err := decodeHexField(input.ServeRef, "serve_ref", 32)
	if err != nil {
		t.Fatalf("decode serve_ref: %v", err)
	}
	evidenceRef, err := decodeHexField(input.EvidenceRef, "evidence_ref", 0)
	if err != nil {
		t.Fatalf("decode evidence_ref: %v", err)
	}
	entry := &servetypes.EventEntry{Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
		EpisodeRef:  episodeRef,
		ServeRef:    serveRef,
		Worked:      input.Worked,
		EvidenceRef: evidenceRef,
	}}}
	body, err := servetypes.CanonicalEventBody(servetypes.EventType_EVENT_TYPE_OUTCOME, orgID, memoryHash, input.EpochID, signerPubkey, nonce, entry)
	if err != nil {
		t.Fatalf("CanonicalEventBody: %v", err)
	}
	return hexOf(servetypes.ComputeEventFingerprint(body))
}

func bytes64(b byte) []byte {
	out := make([]byte, 64)
	for i := range out {
		out[i] = b
	}
	return out
}
