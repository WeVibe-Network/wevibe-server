package chain

import (
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/standing"
)

func TestFilterOutcomeReplayEvents(t *testing.T) {
	tests := []struct {
		name     string
		events   []standingReplayEvent
		accepted map[string]map[uint64]map[string]bool
		want     []standing.Kind
	}{
		{
			name:   "keeps chain accepted outcome",
			events: []standingReplayEvent{{OrgID: "org1", MemoryCID: "mem1", Epoch: 7, Kind: standing.OutcomeWorked, Fingerprint: "aa", ChainGated: true}},
			accepted: map[string]map[uint64]map[string]bool{
				"org1": {7: {"aa": true}},
			},
			want: []standing.Kind{standing.OutcomeWorked},
		},
		{
			name:   "drops rejected outcome",
			events: []standingReplayEvent{{OrgID: "org1", MemoryCID: "mem1", Epoch: 7, Kind: standing.OutcomeFailed, Fingerprint: "bb", ChainGated: true}},
			accepted: map[string]map[uint64]map[string]bool{
				"org1": {7: {"aa": true}},
			},
			want: nil,
		},
		{
			name: "serve and block pass through without chain outcome gate",
			events: []standingReplayEvent{
				{OrgID: "org1", MemoryCID: "mem1", Epoch: 7, Kind: standing.Serve},
				{OrgID: "org1", MemoryCID: "mem1", Epoch: 7, Kind: standing.Block},
				{OrgID: "org1", MemoryCID: "mem1", Epoch: 7, Kind: standing.OutcomeWorked, Fingerprint: "aa", ChainGated: true},
			},
			accepted: map[string]map[uint64]map[string]bool{
				"org1": {7: {"cc": true}},
			},
			want: []standing.Kind{standing.Serve, standing.Block},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := filterOutcomeReplayEvents(tt.events, tt.accepted)
			if len(got) != len(tt.want) {
				t.Fatalf("len(got)=%d want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i].Kind != tt.want[i] {
					t.Fatalf("got[%d].Kind=%v want %v", i, got[i].Kind, tt.want[i])
				}
			}
		})
	}
}
