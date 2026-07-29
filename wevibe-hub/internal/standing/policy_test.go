package standing

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

const realPolicyPath = "../../policy/edge-policy-v1.json"

func TestLoadPolicyRealFile(t *testing.T) {
	policy, err := LoadPolicy(realPolicyPath)
	if err != nil {
		t.Fatalf("LoadPolicy() error = %v", err)
	}

	raw, err := os.ReadFile(realPolicyPath)
	if err != nil {
		t.Fatalf("read policy for hash check: %v", err)
	}
	sum := sha256.Sum256(raw)
	wantHash := hex.EncodeToString(sum[:])

	if policy.Version != "edge-policy-v1" {
		t.Fatalf("Version = %q, want edge-policy-v1", policy.Version)
	}
	if policy.HashHex != wantHash {
		t.Fatalf("HashHex = %q, want sha256(raw file) %q", policy.HashHex, wantHash)
	}
	if len(policy.HashHex) != 64 {
		t.Fatalf("HashHex length = %d, want 64", len(policy.HashHex))
	}
	if policy.Constants.InitialStandingBps != 10000 || policy.Constants.StandingThresholdBps != 1500 {
		t.Fatalf("loaded constants mismatch: %+v", policy.Constants)
	}
}

func TestLoadPolicyRejectsInvalidPolicy(t *testing.T) {
	path := writeTempPolicy(t, `{"policy_version":"edge-policy-v1","constants":{"initial_standing_bps":10001}}`)

	_, err := LoadPolicy(path)
	if err == nil {
		t.Fatal("LoadPolicy() error = nil, want validation error")
	}
	if !strings.Contains(err.Error(), "initial_standing_bps") {
		t.Fatalf("LoadPolicy() error = %q, want initial_standing_bps validation", err)
	}
}

func writeTempPolicy(t *testing.T, body string) string {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "standing-policy-*.json")
	if err != nil {
		t.Fatalf("CreateTemp: %v", err)
	}
	if _, err := file.WriteString(body); err != nil {
		t.Fatalf("WriteString: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return file.Name()
}
