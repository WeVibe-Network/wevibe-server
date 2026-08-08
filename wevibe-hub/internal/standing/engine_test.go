package standing

import (
	"fmt"
	"testing"
)

const (
	refA                      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	refB                      = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	liveServeSeq              = "99e911e79be172528f04249cc60848715b92480993d685fcaad397403b2f1e0b"
	liveOutcomeBeforeServeSeq = "9417b0cc00000000000000000000000000000000000000000000000000000000"
	liveOutcomeAfterServeSeq  = "aa17b0cc00000000000000000000000000000000000000000000000000000000"
)

func testPolicy(t *testing.T) Policy {
	t.Helper()
	policy, err := LoadPolicy(realPolicyPath)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}
	return policy
}

func ev(epoch uint64, kind Kind, ref, seq string) Event {
	return Event{Epoch: epoch, Kind: kind, Ref: ref, Seq: seq}
}

func TestGraceProtectsWhileCountsAccumulate(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(0, Serve, refA, "001"),
		ev(5, OutcomeFailed, refA, "002"),
	}, 0, 19, policy)

	if result.StandingBps != 10000 {
		t.Fatalf("StandingBps = %d, want grace-protected 10000", result.StandingBps)
	}
	if result.ServeCount != 0 || result.DenialCount != 1 {
		t.Fatalf("counts = (%d,%d), want (0,1) after pending serve resolves to denial", result.ServeCount, result.DenialCount)
	}
	if result.Trusted {
		t.Fatal("Trusted = true, want false after 100% denial rate")
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
	result := Compute([]Event{ev(0, Serve, refA, "001"), ev(1, OutcomeWorked, refA, "002")}, 0, 100, policy)

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
		ev(0, Serve, refA, "001"),
		ev(20, OutcomeFailed, refA, "002"),
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

func TestUnknownOutcomeContributesNothing(t *testing.T) {
	policy := testPolicy(t)
	baseline := Compute(nil, 0, 20, policy)
	worked := Compute([]Event{ev(20, OutcomeWorked, refA, "001")}, 0, 20, policy)
	failed := Compute([]Event{ev(20, OutcomeFailed, refA, "001")}, 0, 20, policy)

	if worked != baseline {
		t.Fatalf("unknown worked outcome result = %+v, want baseline %+v", worked, baseline)
	}
	if failed != baseline {
		t.Fatalf("unknown failed outcome result = %+v, want baseline %+v", failed, baseline)
	}
}

func TestNoOutcomeServeIsNeutralAndVoid(t *testing.T) {
	policy := testPolicy(t)
	baselineBeforeServeEpoch := Compute(nil, 0, 19, policy)
	result := Compute([]Event{ev(20, Serve, refA, "001")}, 0, 20, policy)

	if result.StandingBps != baselineBeforeServeEpoch.StandingBps {
		t.Fatalf("StandingBps = %d, want unchanged pre-serve standing %d", result.StandingBps, baselineBeforeServeEpoch.StandingBps)
	}
	if result.ServeCount != 0 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want (0,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
}

func TestReferencePairingChoosesRightServeWithSameMemoryAtDifferentEpochs(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(20, Serve, refA, "001"),
		ev(21, Serve, refB, "002"),
		ev(22, OutcomeWorked, refB, "003"),
	}, 0, 100, policy)

	if result.ServeCount != 2 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want only refB realized as two-quanta serve and refA voided (2,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
}

func TestOutcomeOutsideWindowIgnoredAndServeVoids(t *testing.T) {
	policy := testPolicy(t)
	window := policy.Constants.ServePendingWindowEpochs
	result := Compute([]Event{
		ev(20, Serve, refA, "001"),
		ev(20+window+1, OutcomeWorked, refA, "002"),
	}, 0, 20+window+1, policy)

	if result.ServeCount != 0 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want outside-window outcome ignored and serve voided (0,0,1)", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if result.Trusted {
		t.Fatalf("Trusted = true, want no trust from ignored outside-window outcome; result=%+v", result)
	}
}

func TestSameEpochWorkedOutcomePairsWhenOutcomeSeqSortsBeforeServeSeq(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(24, OutcomeWorked, liveServeSeq, liveOutcomeBeforeServeSeq),
		ev(24, Serve, liveServeSeq, liveServeSeq),
	}, 0, 24, policy)

	if result.ServeCount != policy.Constants.WorkedServeQuanta || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want same-epoch worked outcome to pair for %d serve quanta and no void", result, policy.Constants.WorkedServeQuanta)
	}
}

func TestSameEpochWorkedOutcomePairsWhenOutcomeSeqSortsAfterServeSeq(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(24, OutcomeWorked, liveServeSeq, liveOutcomeAfterServeSeq),
		ev(24, Serve, liveServeSeq, liveServeSeq),
	}, 0, 24, policy)

	if result.ServeCount != policy.Constants.WorkedServeQuanta || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want same-epoch worked outcome to pair for %d serve quanta and no void", result, policy.Constants.WorkedServeQuanta)
	}
}

func TestSameEpochFailedOutcomePairsAsOneDenial(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(24, OutcomeFailed, liveServeSeq, liveOutcomeBeforeServeSeq),
		ev(24, Serve, liveServeSeq, liveServeSeq),
	}, 0, 24, policy)

	if result.ServeCount != 0 || result.DenialCount != 1 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want same-epoch failed outcome to pair as exactly one denial and no void", result)
	}
}

func TestSameEpochTwoServesPairByDistinctRefs(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(24, OutcomeWorked, refB, "001"),
		ev(24, Serve, refA, "010"),
		ev(24, OutcomeWorked, refA, "002"),
		ev(24, Serve, refB, "020"),
	}, 0, 24, policy)

	wantServes := 2 * policy.Constants.WorkedServeQuanta
	if result.ServeCount != wantServes || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want two distinct same-epoch refs to pair for %d serve quanta and no void", result, wantServes)
	}
}

func TestFirstPairingWinsByEpochThenSeq(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{
		ev(20, Serve, refA, "001"),
		ev(21, OutcomeFailed, refA, "b"),
		ev(21, OutcomeWorked, refA, "a"),
	}, 0, 21, policy)

	if result.ServeCount != 2 || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want lower Seq worked outcome to consume serve and later failure ignored", result)
	}
}

func TestInputOrderIndependence(t *testing.T) {
	policy := testPolicy(t)
	ordered := []Event{
		ev(20, Serve, refA, "001"),
		ev(21, Serve, refB, "002"),
		ev(22, OutcomeWorked, refB, "003"),
		ev(23, Block, "", "004"),
		ev(24, OutcomeFailed, refA, "005"),
		ev(24, Serve, liveServeSeq, liveServeSeq),
		ev(24, OutcomeWorked, liveServeSeq, liveOutcomeBeforeServeSeq),
	}
	shuffled := []Event{ordered[6], ordered[3], ordered[1], ordered[5], ordered[4], ordered[0], ordered[2]}

	first := Compute(ordered, 0, 80, policy)
	second := Compute(shuffled, 0, 80, policy)
	if first != second {
		t.Fatalf("Compute order-dependent: ordered=%+v shuffled=%+v", first, second)
	}
}

func TestWorkedPairCreditsTwoServesFailedPairOneDenialAndBlockUnchanged(t *testing.T) {
	policy := testPolicy(t)
	worked := Compute([]Event{ev(20, Serve, refA, "001"), ev(21, OutcomeWorked, refA, "002")}, 0, 21, policy)
	failed := Compute([]Event{ev(20, Serve, refA, "001"), ev(21, OutcomeFailed, refA, "002")}, 0, 21, policy)
	block := Compute([]Event{ev(20, Block, "", "001")}, 0, 20, policy)

	if worked.ServeCount != 2 || worked.DenialCount != 0 || worked.VoidServes != 0 {
		t.Fatalf("worked result = %+v, want two serve quanta, no denial, no void", worked)
	}
	if failed.ServeCount != 0 || failed.DenialCount != 1 || failed.VoidServes != 0 {
		t.Fatalf("failed result = %+v, want one denial, no serve credit, no void", failed)
	}
	if block.ServeCount != 0 || block.DenialCount != 1 || block.VoidServes != 0 {
		t.Fatalf("block result = %+v, want unchanged direct one-denial block", block)
	}
}

func TestComputeDoesNotMutateInputSlice(t *testing.T) {
	policy := testPolicy(t)
	events := []Event{
		ev(22, OutcomeWorked, refA, "003"),
		ev(20, Serve, refA, "001"),
		ev(21, Block, "", "002"),
	}
	original := append([]Event(nil), events...)

	_ = Compute(events, 0, 30, policy)

	for i := range events {
		if events[i] != original[i] {
			t.Fatalf("events[%d] mutated: got %+v want %+v", i, events[i], original[i])
		}
	}
}

func TestClampBounds(t *testing.T) {
	policy := testPolicy(t)
	var manyServes []Event
	for i := 0; i < 100; i++ {
		ref := fmt.Sprintf("%064x", i+1)
		manyServes = append(manyServes, ev(20, Serve, ref, fmt.Sprintf("s%03d", i)))
	}
	for i := 0; i < 100; i++ {
		ref := fmt.Sprintf("%064x", i+1)
		manyServes = append(manyServes, ev(20, OutcomeWorked, ref, fmt.Sprintf("o%03d", i)))
	}
	if got := Compute(manyServes, 0, 20, policy).StandingBps; got != 10000 {
		t.Fatalf("many serve StandingBps = %d, want upper clamp 10000", got)
	}

	var manyFailures []Event
	for i := 0; i < 100; i++ {
		manyFailures = append(manyFailures, ev(20, Block, "", fmt.Sprintf("b%03d", i)))
	}
	if got := Compute(manyFailures, 0, 20, policy).StandingBps; got != 0 {
		t.Fatalf("many failure StandingBps = %d, want lower clamp 0", got)
	}
}

func TestDeterministicSameInputs(t *testing.T) {
	policy := testPolicy(t)
	events := []Event{
		ev(0, Serve, refA, "001"),
		ev(20, Block, "", "002"),
		ev(21, OutcomeWorked, refA, "003"),
		ev(22, OutcomeFailed, refB, "004"),
	}

	first := Compute(events, 0, 60, policy)
	second := Compute(events, 0, 60, policy)
	if first != second {
		t.Fatalf("Compute not deterministic: first=%+v second=%+v", first, second)
	}
}

func TestUnobservedOutcomeDoesNotClaimServe(t *testing.T) {
	policy := testPolicy(t)
	baselineBeforeServeEpoch := Compute(nil, 0, 19, policy)
	result := Compute([]Event{ev(20, Serve, refA, "001"), ev(20, OutcomeUnobserved, refA, "002")}, 0, 20, policy)
	if result.StandingBps != baselineBeforeServeEpoch.StandingBps {
		t.Fatalf("StandingBps = %d, want unchanged pre-serve standing %d (unobserved contributes nothing)", result.StandingBps, baselineBeforeServeEpoch.StandingBps)
	}
	if result.ServeCount != 0 || result.DenialCount != 0 || result.VoidServes != 1 {
		t.Fatalf("counts = (%d,%d,%d), want (0,0,1) — serve voids unclaimed", result.ServeCount, result.DenialCount, result.VoidServes)
	}
	if result.UnobservedOutcomes != 1 {
		t.Fatalf("UnobservedOutcomes = %d, want 1", result.UnobservedOutcomes)
	}
}

func TestUnobservedThenWorkedStillPairs(t *testing.T) {
	policy := testPolicy(t)
	result := Compute([]Event{ev(20, Serve, refA, "001"), ev(20, OutcomeUnobserved, refA, "002"), ev(21, OutcomeWorked, refA, "003")}, 0, 21, policy)
	if result.ServeCount != policy.Constants.WorkedServeQuanta || result.DenialCount != 0 || result.VoidServes != 0 {
		t.Fatalf("result = %+v, want worked to pair after unobserved (non-claiming)", result)
	}
	if result.UnobservedOutcomes != 1 {
		t.Fatalf("UnobservedOutcomes = %d, want 1", result.UnobservedOutcomes)
	}
}

func TestUnobservedUnknownServeContributesNothing(t *testing.T) {
	policy := testPolicy(t)
	baseline := Compute(nil, 0, 20, policy)
	result := Compute([]Event{ev(20, OutcomeUnobserved, refA, "001")}, 0, 20, policy)
	if result != baseline {
		// UnobservedOutcomes differs by design; compare the standing-bearing fields.
		if result.StandingBps != baseline.StandingBps || result.ServeCount != baseline.ServeCount || result.DenialCount != baseline.DenialCount || result.VoidServes != baseline.VoidServes {
			t.Fatalf("result = %+v, want standing-bearing fields equal to baseline %+v", result, baseline)
		}
	}
	if result.UnobservedOutcomes != 1 {
		t.Fatalf("UnobservedOutcomes = %d, want 1", result.UnobservedOutcomes)
	}
}
