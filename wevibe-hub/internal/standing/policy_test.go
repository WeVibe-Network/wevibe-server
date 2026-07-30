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
	if policy.Constants.ServePendingWindowEpochs != 1440 {
		t.Fatalf("ServePendingWindowEpochs = %d, want 1440", policy.Constants.ServePendingWindowEpochs)
	}
}

func TestLoadPolicyRejectsInvalidPolicy(t *testing.T) {
	tests := []struct {
		name    string
		body    string
		wantErr string
	}{
		{
			name:    "initial standing out of range",
			body:    `{"policy_version":"edge-policy-v1","constants":{"initial_standing_bps":10001,"serve_pending_window_epochs":1440}}`,
			wantErr: "initial_standing_bps",
		},
		{
			name:    "serve pending window missing",
			body:    `{"policy_version":"edge-policy-v1","constants":{"initial_standing_bps":10000}}`,
			wantErr: "serve_pending_window_epochs",
		},
		{
			name:    "serve pending window zero",
			body:    `{"policy_version":"edge-policy-v1","constants":{"initial_standing_bps":10000,"serve_pending_window_epochs":0}}`,
			wantErr: "serve_pending_window_epochs",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := writeTempPolicy(t, tt.body)

			_, err := LoadPolicy(path)
			if err == nil {
				t.Fatal("LoadPolicy() error = nil, want validation error")
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("LoadPolicy() error = %q, want %s validation", err, tt.wantErr)
			}
		})
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
