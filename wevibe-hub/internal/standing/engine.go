package standing

import "math"

// Kind is the recall-pivot evidence kind folded into memory standing.
type Kind int

const (
	Serve Kind = iota
	Block
	OutcomeWorked
	OutcomeFailed
)

// Event is one ordered recall event for a memory.
type Event struct {
	Epoch uint64
	Kind  Kind
}

// Result is the derived per-memory standing scalar and visibility outcome.
type Result struct {
	StandingBps int32
	ServeCount  uint64
	DenialCount uint64
	VoidServes  uint64
	DenialRate  float64
	Trusted     bool
	Archived    bool
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
	tallies, voidServes := resolvePendingServes(events, createdEpoch, currentEpoch, c.ServePendingWindowEpochs)
	if currentEpoch < createdEpoch {
		return finalizeResult(standing, serves, denials, voidServes, c)
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

	return finalizeResult(standing, serves, denials, voidServes, c)
}

func resolvePendingServes(events []Event, createdEpoch, currentEpoch, window uint64) (map[uint64]epochTally, uint64) {
	tallies := make(map[uint64]epochTally)
	pending := make([]uint64, 0)
	pendingHead := 0
	var voidServes uint64

	markActivity := func(epoch uint64) {
		tally := tallies[epoch]
		tally.activity = true
		tallies[epoch] = tally
	}
	addServe := func(epoch uint64) {
		tally := tallies[epoch]
		tally.serves++
		tally.activity = true
		tallies[epoch] = tally
	}
	addDenial := func(epoch uint64) {
		tally := tallies[epoch]
		tally.denials++
		tally.activity = true
		tallies[epoch] = tally
	}

	for _, event := range events {
		if event.Epoch < createdEpoch {
			continue
		}
		if event.Epoch > currentEpoch {
			break
		}

		switch event.Kind {
		case Serve:
			pending = append(pending, event.Epoch)
			markActivity(event.Epoch)
		case OutcomeWorked, OutcomeFailed:
			for pendingHead < len(pending) && event.Epoch-pending[pendingHead] > window {
				pendingHead++
				voidServes++
			}
			if pendingHead < len(pending) {
				serveEpoch := pending[pendingHead]
				pendingHead++
				if event.Kind == OutcomeWorked {
					addServe(serveEpoch)
				} else {
					addDenial(serveEpoch)
				}
				continue
			}
			if event.Kind == OutcomeWorked {
				addServe(event.Epoch)
			} else {
				addDenial(event.Epoch)
			}
		case Block:
			addDenial(event.Epoch)
		}
	}

	voidServes += uint64(len(pending) - pendingHead)
	return tallies, voidServes
}

func finalizeResult(standing float64, serves, denials, voidServes uint64, c Constants) Result {
	standingBps := int32(clampStanding(math.Round(standing)))
	return Result{
		StandingBps: standingBps,
		ServeCount:  serves,
		DenialCount: denials,
		VoidServes:  voidServes,
		DenialRate:  denialRate(serves, denials),
		Trusted:     trusted(serves, denials, c),
		Archived:    standingBps <= c.StandingThresholdBps,
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
