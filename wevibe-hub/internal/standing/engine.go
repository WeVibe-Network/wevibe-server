package standing

import (
	"math"
	"sort"
)

// Kind is the recall-pivot evidence kind folded into memory standing.
type Kind int

const (
	Serve Kind = iota
	Block
	OutcomeWorked
	OutcomeFailed
	// OutcomeUnobserved records an episode that closed with no resolution
	// signal. It is non-claiming: the serve stays pending until a
	// worked/didnt_work outcome pairs or the pending window voids it
	// (WO-ATTRIB 2026-08-07 — silence is not a vote).
	OutcomeUnobserved
)

// Event is one recall event for a memory.
type Event struct {
	// Epoch is the public chain epoch that contains this event.
	Epoch uint64
	// Kind is the standing evidence kind carried by this event.
	Kind Kind
	// Ref is the explicit pairing reference. For Serve events it is that serve's
	// own fingerprint hex; for OutcomeWorked/OutcomeFailed events it is the
	// serve_ref hex that points at the served evidence; for Block events it is
	// empty and ignored.
	Ref string
	// Seq is this event's own event-fingerprint hex. It is used only as a
	// deterministic tiebreak after Epoch and KindRank so replay folds the public
	// event log in a total order of (Epoch ASC, KindRank ASC, Seq ASC).
	Seq string
}

// Result is the derived per-memory standing scalar and visibility outcome.
type Result struct {
	StandingBps int32
	ServeCount  uint64
	DenialCount uint64
	VoidServes  uint64
	// UnobservedOutcomes counts non-claiming unobserved-use observations.
	// Coverage evidence only; contributes nothing to standing.
	UnobservedOutcomes uint64
	DenialRate         float64
	Trusted            bool
	Archived           bool
}

type epochTally struct {
	serves   uint64
	denials  uint64
	activity bool
}

// Compute derives standing from ordered memory events, creation/current epochs,
// and a versioned edge policy. It is pure: no I/O, no time reads, no logging.
//
// Determinism intent: the engine performs a fixed epoch-order fold using
// float64 arithmetic and rounds once to the nearest basis point after each
// epoch delta. Given identical inputs and Go's specified IEEE-754 float64
// operations, the output is stable and rebuildable.
func Compute(events []Event, createdEpoch, currentEpoch uint64, policy Policy) Result {
	c := policy.Constants
	standing := float64(c.InitialStandingBps)

	var serves uint64
	var denials uint64
	tallies, voidServes, unobserved := resolvePendingServes(events, createdEpoch, currentEpoch, c.ServePendingWindowEpochs, c.WorkedServeQuanta)
	if currentEpoch < createdEpoch {
		return finalizeResult(standing, serves, denials, voidServes, unobserved, c)
	}

	for epoch := createdEpoch; epoch <= currentEpoch; epoch++ {
		tally := tallies[epoch]
		epochServes := tally.serves
		epochDenials := tally.denials

		serves += epochServes
		denials += epochDenials
		if epoch-createdEpoch < c.GraceEpochs {
			continue
		}

		denialRate := denialRate(serves, denials)
		trust := 1 - denialRate
		if epochServes > 0 {
			serveWeight := c.ServeFloor + (1-c.ServeFloor)*trust*trust
			standing += float64(c.ServeDBps) * float64(epochServes) * serveWeight
		}
		if epochDenials > 0 {
			denialWeight := c.DenialFloor + (1-c.DenialFloor)*denialRate
			standing -= float64(c.DenialDBps) * float64(epochDenials) * denialWeight
		}
		if !tally.activity {
			idleRate := c.IdleUntrusted
			if trusted(serves, denials, c) {
				idleRate = c.IdleProtect
			}
			standing -= float64(c.IdleDBps) * idleRate
		}
		standing = clampStanding(math.Round(standing))
	}

	return finalizeResult(standing, serves, denials, voidServes, unobserved, c)
}

func resolvePendingServes(events []Event, createdEpoch, currentEpoch, window, workedServeQuanta uint64) (map[uint64]epochTally, uint64, uint64) {
	tallies := make(map[uint64]epochTally)
	ordered := append([]Event(nil), events...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].Epoch != ordered[j].Epoch {
			return ordered[i].Epoch < ordered[j].Epoch
		}
		if eventKindRank(ordered[i].Kind) != eventKindRank(ordered[j].Kind) {
			return eventKindRank(ordered[i].Kind) < eventKindRank(ordered[j].Kind)
		}
		return ordered[i].Seq < ordered[j].Seq
	})
	pending := make([]pendingServe, 0)
	var voidServes uint64
	var unobserved uint64

	markActivity := func(epoch uint64) {
		tally := tallies[epoch]
		tally.activity = true
		tallies[epoch] = tally
	}
	addServe := func(epoch uint64, quanta uint64) {
		tally := tallies[epoch]
		tally.serves += quanta
		tally.activity = true
		tallies[epoch] = tally
	}
	addDenial := func(epoch uint64) {
		tally := tallies[epoch]
		tally.denials++
		tally.activity = true
		tallies[epoch] = tally
	}

	for _, event := range ordered {
		if event.Epoch < createdEpoch {
			continue
		}
		if event.Epoch > currentEpoch {
			break
		}

		switch event.Kind {
		case Serve:
			pending = append(pending, pendingServe{epoch: event.Epoch, ref: event.Ref})
			markActivity(event.Epoch)
		case OutcomeWorked, OutcomeFailed:
			serveIndex := matchingServeIndex(pending, event, window)
			if serveIndex >= 0 {
				serveEpoch := pending[serveIndex].epoch
				pending[serveIndex].claimed = true
				if event.Kind == OutcomeWorked {
					addServe(serveEpoch, workedServeQuanta)
				} else {
					addDenial(serveEpoch)
				}
			}
		case OutcomeUnobserved:
			// Non-claiming by design: no pairing, no tally, no activity mark.
			// The observation exists so coverage can be measured and policy can
			// distinguish "never seen" from "seen but unresolved".
			unobserved++
		case Block:
			addDenial(event.Epoch)
		}
	}

	for _, serve := range pending {
		if !serve.claimed {
			voidServes++
		}
	}
	return tallies, voidServes, unobserved
}

// eventKindRank preserves same-epoch causality in the public replay order:
// a serve-registering event (Serve or Block) is never causally after an outcome
// that consumes same-epoch evidence, while fingerprint hash order carries no
// causal information. Seq remains the deterministic tiebreak within the same
// epoch and same causal class.
func eventKindRank(kind Kind) int {
	switch kind {
	case Serve, Block:
		return 0
	case OutcomeWorked, OutcomeFailed, OutcomeUnobserved:
		return 1
	default:
		return 2
	}
}

type pendingServe struct {
	epoch   uint64
	ref     string
	claimed bool
}

// matchingServeIndex applies explicit serve_ref pairing. An outcome pairs only
// to an unclaimed earlier Serve with the same Ref and within the pending window;
// unknown/out-of-window outcomes contribute nothing. Double-spend rejection is
// first-pairing-wins: events are processed in (Epoch ASC, KindRank ASC, Seq ASC)
// order, so the first in-window outcome to claim a serve consumes it, and later
// outcomes with the same Ref are ignored entirely as duplicate/replay evidence.
func matchingServeIndex(pending []pendingServe, outcome Event, window uint64) int {
	for i := range pending {
		serve := pending[i]
		if serve.claimed || serve.ref == "" || serve.ref != outcome.Ref {
			continue
		}
		if outcome.Epoch < serve.epoch || outcome.Epoch-serve.epoch > window {
			continue
		}
		return i
	}
	return -1
}

func finalizeResult(standing float64, serves, denials, voidServes, unobserved uint64, c Constants) Result {
	standingBps := int32(clampStanding(math.Round(standing)))
	return Result{
		StandingBps:        standingBps,
		ServeCount:         serves,
		DenialCount:        denials,
		VoidServes:         voidServes,
		UnobservedOutcomes: unobserved,
		DenialRate:         denialRate(serves, denials),
		Trusted:            trusted(serves, denials, c),
		Archived:           standingBps <= c.StandingThresholdBps,
	}
}

func denialRate(serves, denials uint64) float64 {
	total := serves + denials
	if total == 0 {
		return 0
	}
	return float64(denials) / float64(total)
}

func trusted(serves, denials uint64, c Constants) bool {
	return serves >= c.TrustMinServes && denialRate(serves, denials) < c.TrustMaxRate
}

func clampStanding(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 10000 {
		return 10000
	}
	return v
}
