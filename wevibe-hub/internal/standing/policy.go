package standing

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
)

// Constants are the revisable edge-policy values used by the standing engine.
type Constants struct {
	InitialStandingBps       int32   `json:"initial_standing_bps"`
	ServeDBps                int32   `json:"serve_d_bps"`
	DenialDBps               int32   `json:"denial_d_bps"`
	IdleDBps                 int32   `json:"idle_d_bps"`
	GraceEpochs              uint64  `json:"grace_epochs"`
	TrustMinServes           uint64  `json:"trust_min_serves"`
	TrustMaxRate             float64 `json:"trust_max_rate"`
	IdleProtect              float64 `json:"idle_protect"`
	IdleUntrusted            float64 `json:"idle_untrusted"`
	ServeFloor               float64 `json:"serve_floor"`
	DenialFloor              float64 `json:"denial_floor"`
	StandingThresholdBps     int32   `json:"standing_threshold_bps"`
	ServePendingWindowEpochs uint64  `json:"serve_pending_window_epochs"`
}

// Policy is a parsed edge policy plus the SHA-256 hash of its raw file bytes.
type Policy struct {
	Version   string
	HashHex   string
	Constants Constants
}

type policyFile struct {
	Version   string    `json:"policy_version"`
	Constants Constants `json:"constants"`
}

// LoadPolicy reads, hashes, parses, and validates a standing edge policy file.
// It performs no logging; callers own operation logging and trace context.
func LoadPolicy(path string) (Policy, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Policy{}, fmt.Errorf("read standing policy: %w", err)
	}

	var file policyFile
	if err := json.Unmarshal(raw, &file); err != nil {
		return Policy{}, fmt.Errorf("parse standing policy: %w", err)
	}

	if err := validatePolicyFile(file); err != nil {
		return Policy{}, err
	}

	sum := sha256.Sum256(raw)
	return Policy{
		Version:   file.Version,
		HashHex:   hex.EncodeToString(sum[:]),
		Constants: file.Constants,
	}, nil
}

func validatePolicyFile(file policyFile) error {
	if file.Version == "" {
		return fmt.Errorf("standing policy: policy_version is required")
	}
	c := file.Constants
	if c.InitialStandingBps < 0 || c.InitialStandingBps > 10000 {
		return fmt.Errorf("standing policy: initial_standing_bps must be in [0,10000]")
	}
	if c.ServeDBps < 0 || c.DenialDBps < 0 || c.IdleDBps < 0 {
		return fmt.Errorf("standing policy: delta bps values must be non-negative")
	}
	if c.StandingThresholdBps < 0 || c.StandingThresholdBps > 10000 {
		return fmt.Errorf("standing policy: standing_threshold_bps must be in [0,10000]")
	}
	if c.ServePendingWindowEpochs == 0 {
		return fmt.Errorf("standing policy: serve_pending_window_epochs must be positive")
	}
	if c.TrustMaxRate < 0 || c.TrustMaxRate > 1 {
		return fmt.Errorf("standing policy: trust_max_rate must be in [0,1]")
	}
	if !unitInterval(c.IdleProtect) || !unitInterval(c.IdleUntrusted) || !unitInterval(c.ServeFloor) || !unitInterval(c.DenialFloor) {
		return fmt.Errorf("standing policy: rate multipliers and floors must be in [0,1]")
	}
	return nil
}

func unitInterval(v float64) bool {
	return v >= 0 && v <= 1
}
