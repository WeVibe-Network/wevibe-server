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
	if result.ServeCount != 1 || result.DenialCount != 1 {
		t.Fatalf("counts = (%d,%d), want (1,1)", result.ServeCount, result.DenialCount)
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
	result := Compute([]Event{{Epoch: 0, Kind: Serve}}, 0, 100, policy)

	if !result.Trusted {
		t.Fatal("Trusted = false, want true after one clean serve")
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
	if result.StandingBps != 1015 || !result.Archived {
		t.Fatalf("result = %+v, want fast drain to archived standing 1015", result)
	}
}

func TestWorkedOutcomesBoostLikeServes(t *testing.T) {
	policy := testPolicy(t)
	worked := Compute([]Event{{Epoch: 20, Kind: OutcomeWorked}}, 0, 20, policy)
	served := Compute([]Event{{Epoch: 20, Kind: Serve}}, 0, 20, policy)

	if worked != served {
		t.Fatalf("OutcomeWorked result = %+v, want Serve-equivalent %+v", worked, served)
	}
	if worked.ServeCount != 1 {
		t.Fatalf("ServeCount = %d, want 1", worked.ServeCount)
	}
}

func TestClampBounds(t *testing.T) {
	policy := testPolicy(t)
	var manyServes []Event
	for i := 0; i < 100; i++ {
		manyServes = append(manyServes, Event{Epoch: 20, Kind: Serve})
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
