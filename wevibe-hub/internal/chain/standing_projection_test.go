package chain

import (
	"testing"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/standing"
)

var standingProjectionTestPolicy = standing.Policy{
	Version: "test",
	Constants: standing.Constants{
		InitialStandingBps:       10000,
		ServeDBps:                100,
		DenialDBps:               100,
		IdleDBps:                 0,
		GraceEpochs:              0,
		TrustMinServes:           1,
		TrustMaxRate:             0.5,
		IdleProtect:              0,
		IdleUntrusted:            0,
		ServeFloor:               1,
		DenialFloor:              1,
		StandingThresholdBps:     1500,
		ServePendingWindowEpochs: 10,
		WorkedServeQuanta:        2,
	},
}

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

func TestStandingReplayEventsPairByServeRef(t *testing.T) {
	got := computeStandingFromReplay(t, []standingReplayEvent{
		{Epoch: 1, Kind: standing.Serve, Ref: "serve-a", Seq: "serve-a"},
		{Epoch: 2, Kind: standing.OutcomeWorked, Ref: "serve-a", Seq: "outcome-a", Fingerprint: "outcome-a", ChainGated: true},
	})
	if got.ServeCount != 2 {
		t.Fatalf("ServeCount=%d want 2", got.ServeCount)
	}
	if got.DenialCount != 0 {
		t.Fatalf("DenialCount=%d want 0", got.DenialCount)
	}
}

func TestStandingReplayOutcomeWithUnknownServeRefContributesNothing(t *testing.T) {
	got := computeStandingFromReplay(t, []standingReplayEvent{
		{Epoch: 1, Kind: standing.OutcomeWorked, Ref: "missing-serve", Seq: "outcome-a", Fingerprint: "outcome-a", ChainGated: true},
	})
	if got.ServeCount != 0 {
		t.Fatalf("ServeCount=%d want 0", got.ServeCount)
	}
	if got.DenialCount != 0 {
		t.Fatalf("DenialCount=%d want 0", got.DenialCount)
	}
	if got.VoidServes != 0 {
		t.Fatalf("VoidServes=%d want 0", got.VoidServes)
	}
}

func TestStandingReplayOutcomeCreditsReferencedSecondServeEpoch(t *testing.T) {
	got := computeStandingFromReplay(t, []standingReplayEvent{
		{Epoch: 1, Kind: standing.Serve, Ref: "serve-first", Seq: "serve-first"},
		{Epoch: 3, Kind: standing.Serve, Ref: "serve-second", Seq: "serve-second"},
		{Epoch: 4, Kind: standing.OutcomeWorked, Ref: "serve-second", Seq: "outcome-second", Fingerprint: "outcome-second", ChainGated: true},
	})
	if got.ServeCount != 2 {
		t.Fatalf("ServeCount=%d want 2", got.ServeCount)
	}
	if got.VoidServes != 1 {
		t.Fatalf("VoidServes=%d want 1", got.VoidServes)
	}
}

func TestStandingReplayChainAcceptFilterKeepsOutcomeFingerprintAsIdentity(t *testing.T) {
	events := []standingReplayEvent{
		{Epoch: 1, Kind: standing.Serve, Ref: "serve-a", Seq: "serve-a", Fingerprint: "serve-a"},
		{OrgID: "org1", MemoryCID: "mem1", Epoch: 2, Kind: standing.OutcomeWorked, Ref: "serve-a", Seq: "outcome-a", Fingerprint: "outcome-a", ChainGated: true},
	}
	accepted := map[string]map[uint64]map[string]bool{"org1": {2: {"serve-a": true}}}
	filtered := filterOutcomeReplayEvents(events, accepted)
	if len(filtered) != 1 {
		t.Fatalf("len(filtered)=%d want 1", len(filtered))
	}
	if filtered[0].Kind != standing.Serve {
		t.Fatalf("filtered[0].Kind=%v want Serve", filtered[0].Kind)
	}
}

func TestStandingReplayOrderIndependent(t *testing.T) {
	replayA := []standingReplayEvent{
		{Epoch: 1, Kind: standing.Serve, Ref: "serve-a", Seq: "serve-a"},
		{Epoch: 3, Kind: standing.OutcomeWorked, Ref: "serve-a", Seq: "outcome-a", Fingerprint: "outcome-a", ChainGated: true},
		{Epoch: 2, Kind: standing.Serve, Ref: "serve-b", Seq: "serve-b"},
		{Epoch: 4, Kind: standing.OutcomeFailed, Ref: "serve-b", Seq: "outcome-b", Fingerprint: "outcome-b", ChainGated: true},
	}
	replayB := []standingReplayEvent{replayA[3], replayA[1], replayA[2], replayA[0]}
	gotA := computeStandingFromReplay(t, replayA)
	gotB := computeStandingFromReplay(t, replayB)
	if gotA != gotB {
		t.Fatalf("standing differs by insertion order: A=%+v B=%+v", gotA, gotB)
	}
}

func computeStandingFromReplay(t *testing.T, replay []standingReplayEvent) standing.Result {
	t.Helper()
	events := make([]standing.Event, 0, len(replay))
	createdEpoch := uint64(0)
	currentEpoch := uint64(0)
	for i, event := range replay {
		events = append(events, standing.Event{Epoch: event.Epoch, Kind: event.Kind, Ref: event.Ref, Seq: event.Seq})
		if i == 0 || event.Epoch < createdEpoch {
			createdEpoch = event.Epoch
		}
		if i == 0 || event.Epoch > currentEpoch {
			currentEpoch = event.Epoch
		}
	}
	return standing.Compute(events, createdEpoch, currentEpoch, standingProjectionTestPolicy)
}
