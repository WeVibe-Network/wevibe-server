package standing

import "testing"

func testPolicy(t *testing.T) Policy {
	t.Helper()
	policy, err := LoadPolicy(realPolicyPath)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}
	return policy
}

func TestGraceProtectsWhileCountsAccumulate(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		{Epoch: 0, Kind: Serve},
		{Epoch: 5, Kind: OutcomeFailed},
	}, 0, 19, policy)

	if result.StandingBps != 10000 {
		t.Fatalf("StandingBps = %d, want grace-protected 10000", result.StandingBps)
	}
	if result.ServeCount != 0 || result.DenialCount != 1 {
		t.Fatalf("counts = (%d,%d), want (0,1) after pending serve resolves to denial", result.ServeCount, result.DenialCount)
	}
	if result.Trusted {
		t.Fatal("Trusted = true, want false after 50% denial rate")
	}
}

func TestUntrustedIdleDrainsToArchive(t *testing.T) {
	policy := testPolicy(t)
	result := Compute(nil, 0, 34, policy)

	if result.StandingBps != 1000 {
		t.Fatalf("StandingBps = %d, want 1000 after 15 untrusted idle epochs", result.StandingBps)
	}
	if !result.Archived {
		t.Fatal("Archived = false, want true at or below threshold")
	}
}

func TestOneServeThenCleanIdleSurvives(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{{Epoch: 0, Kind: Serve}, {Epoch: 1, Kind: OutcomeWorked}}, 0, 100, policy)

	if !result.Trusted {
		t.Fatal("Trusted = false, want true after one realized clean serve")
	}
	if result.Archived {
		t.Fatalf("Archived = true, want false; result=%+v", result)
	}
	if result.StandingBps != 7570 {
		t.Fatalf("StandingBps = %d, want 7570 after protected idle drain", result.StandingBps)
	}
}

func TestFailedOutcomesTripTrustGateAndDrainFast(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		{Epoch: 0, Kind: Serve},
		{Epoch: 20, Kind: OutcomeFailed},
	}, 0, 34, policy)

	if result.DenialRate < policy.Constants.TrustMaxRate {
		t.Fatalf("DenialRate = %f, want >= %f", result.DenialRate, policy.Constants.TrustMaxRate)
	}
	if result.Trusted {
		t.Fatal("Trusted = true, want false after failed outcome trips trust gate")
	}
	if result.StandingBps != 1000 || !result.Archived {
		t.Fatalf("result = %+v, want fast drain to archived standing 1000", result)
	}
}

func TestWorkedOutcomesBoostLikeServes(t *testing.T) {
	policy := testPolicy(t)
	worked := Compute([]Event{{Epoch: 20, Kind: OutcomeWorked}}, 0, 20, policy)

	if worked.ServeCount != 1 {
		t.Fatalf("ServeCount = %d, want orphan worked outcome to count as 1 serve-equivalent", worked.ServeCount)
	}
	if !worked.Trusted {
		t.Fatalf("Trusted = false, want orphan worked outcome to preserve serve-equivalent trust; result=%+v", worked)
	}
}

func TestNoOutcomeServeIsNeutralAndVoid(t *testing.T) {
	policy := testPolicy(t)
	baselineBeforeServeEpoch := Compute(nil, 0, 19, policy)
	result := Compute([]Event{{Epoch: 20, Kind: Serve}}, 0, 20, policy)

	if result.StandingBps != baselineBeforeServeEpoch.StandingBps {
		t.Fatalf("StandingBps = %d, want unchanged pre-serve standing %d", result.StandingBps, baselineBeforeServeEpoch.StandingBps)
	}
	if result.ServeCount != 0 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want (0,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}

	expired := Compute([]Event{{Epoch: 20, Kind: Serve}}, 0, 20+policy.Constants.ServePendingWindowEpochs+1, policy)
	if expired.VoidServes != 1 || expired.ServeCount != 0 || expired.DenialCount != 0 {
		t.Fatalf("expired counts = (%d,%d,%d), want no-outcome serve past window voided as (0,0,1)", expired.ServeCount, expired.DenialCount, expired.VoidServes)
	}
}

func TestServeWorkedOutcomeInWindowRealizesOneServeQuantum(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{{Epoch: 20, Kind: Serve}, {Epoch: 21, Kind: OutcomeWorked}}, 0, 21, policy)
	doubleCounted := Compute([]Event{{Epoch: 20, Kind: OutcomeWorked}, {Epoch: 21, Kind: OutcomeWorked}}, 0, 21, policy)

	if result.ServeCount != 1 || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("counts = (%d,%d,%d), want (1,0,0)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if doubleCounted.ServeCount != 2 {
		t.Fatalf("doubleCounted ServeCount = %d, want 2 for test control", doubleCounted.ServeCount)
	}
	if result.StandingBps >= doubleCounted.StandingBps {
		t.Fatalf("StandingBps = %d, want less than old two-quanta control %d", result.StandingBps, doubleCounted.StandingBps)
	}
}

func TestServeFailedOutcomeInWindowCountsAsDenial(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{{Epoch: 20, Kind: Serve}, {Epoch: 21, Kind: OutcomeFailed}}, 0, 21, policy)

	if result.ServeCount != 0 || result.DenialCount != 1 || result.VoidServes != 0 {
		t.Fatalf("counts = (%d,%d,%d), want (0,1,0)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if result.DenialRate != 1 || result.Trusted {
		t.Fatalf("result = %+v, want failed outcome paired as untrusted denial", result)
	}
}

func TestServeWorkedOutcomeOutsideWindowVoidsServeAndCreditsOrphan(t *testing.T) {
	policy := testPolicy(t)
	window := policy.Constants.ServePendingWindowEpochs
	result := Compute([]Event{{Epoch: 20, Kind: Serve}, {Epoch: 20 + window + 1, Kind: OutcomeWorked}}, 0, 20+window+1, policy)

	if result.ServeCount != 1 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want outside-window serve void plus orphan worked outcome (1,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if !result.Trusted {
		t.Fatalf("Trusted = false, want orphan worked outcome to preserve evidence credit; result=%+v", result)
	}
}

func TestDeterministicInterleavedPendingServeResolution(t *testing.T) {
	policy := testPolicy(t)
	events := []Event{
		{Epoch: 20, Kind: Serve},
		{Epoch: 21, Kind: Serve},
		{Epoch: 22, Kind: OutcomeWorked},
		{Epoch: 23, Kind: Serve},
		{Epoch: 24, Kind: OutcomeFailed},
		{Epoch: 25, Kind: OutcomeWorked},
	}

	first := Compute(events, 0, 80, policy)
	second := Compute(events, 0, 80, policy)
	if first != second {
		t.Fatalf("Compute not deterministic for interleaved pending serves: first=%+v second=%+v", first, second)
	}
	if first.ServeCount != 2 || first.DenialCount != 1 || first.VoidServes != 0 {
		t.Fatalf("result = %+v, want FIFO-resolved counts (serves=2 denials=1 void=0)", first)
	}
}

func TestTwoServesOneWorkedOutcomeRealizesOldestAndVoidsOther(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{{Epoch: 20, Kind: Serve}, {Epoch: 21, Kind: Serve}, {Epoch: 22, Kind: OutcomeWorked}}, 0, 100, policy)

	if result.ServeCount != 1 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want oldest realized and second void (1,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if result.StandingBps != 7630 {
		t.Fatalf("StandingBps = %d, want oldest realized and second serve neutral at 7630", result.StandingBps)
	}
}

func TestClampBounds(t *testing.T) {
	policy := testPolicy(t)
	var manyServes []Event
	for i := 0; i < 100; i++ {
		manyServes = append(manyServes, Event{Epoch: 20, Kind: Serve})
	}
	for i := 0; i < 100; i++ {
		manyServes = append(manyServes, Event{Epoch: 20, Kind: OutcomeWorked})
	}
	if got := Compute(manyServes, 0, 20, policy).StandingBps; got != 10000 {
		t.Fatalf("many serve StandingBps = %d, want upper clamp 10000", got)
	}

	var manyFailures []Event
	for i := 0; i < 100; i++ {
		manyFailures = append(manyFailures, Event{Epoch: 20, Kind: OutcomeFailed})
	}
	if got := Compute(manyFailures, 0, 20, policy).StandingBps; got != 0 {
		t.Fatalf("many failure StandingBps = %d, want lower clamp 0", got)
	}
}

func TestDeterministicSameInputs(t *testing.T) {
	policy := testPolicy(t)
	events := []Event{
		{Epoch: 0, Kind: Serve},
		{Epoch: 20, Kind: Block},
		{Epoch: 21, Kind: OutcomeWorked},
		{Epoch: 22, Kind: OutcomeFailed},
	}

	first := Compute(events, 0, 60, policy)
	second := Compute(events, 0, 60, policy)
	if first != second {
		t.Fatalf("Compute not deterministic: first=%+v second=%+v", first, second)
	}
}
