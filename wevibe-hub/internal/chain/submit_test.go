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
