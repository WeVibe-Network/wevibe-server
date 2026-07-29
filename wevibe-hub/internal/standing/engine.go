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
	DenialRate  float64
	Trusted     bool
	Archived    bool
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
	eventIndex := 0
	if currentEpoch < createdEpoch {
		return finalizeResult(standing, serves, denials, c)
	}

	for epoch := createdEpoch; epoch <= currentEpoch; epoch++ {
		epochServes := uint64(0)
		epochDenials := uint64(0)
		for eventIndex < len(events) && events[eventIndex].Epoch < epoch {
			eventIndex++
		}
		for eventIndex < len(events) && events[eventIndex].Epoch == epoch {
			switch events[eventIndex].Kind {
			case Serve, OutcomeWorked:
				epochServes++
			case Block, OutcomeFailed:
				epochDenials++
			}
			eventIndex++
		}

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
		if epochServes == 0 && epochDenials == 0 {
			idleRate := c.IdleUntrusted
			if trusted(serves, denials, c) {
				idleRate = c.IdleProtect
			}
			standing -= float64(c.IdleDBps) * idleRate
		}
		standing = clampStanding(math.Round(standing))
	}

	return finalizeResult(standing, serves, denials, c)
}

func finalizeResult(standing float64, serves, denials uint64, c Constants) Result {
	standingBps := int32(clampStanding(math.Round(standing)))
	return Result{
		StandingBps: standingBps,
		ServeCount:  serves,
		DenialCount: denials,
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
