package chain

import (
	"errors"
	"testing"
)

func TestPolicyAnchorVerdict(t *testing.T) {
	const localVersion = "edge-policy-v1"
	const localHash = "abc123DEF"

	cases := []struct {
		name            string
		anchoredVersion string
		anchoredHash    string
		found           bool
		queryErr        error
		wantVerdict     string
		wantFatal       bool
	}{
		{
			name:        "query error is non-fatal and continues",
			queryErr:    errors.New("dial tcp: connection refused"),
			wantVerdict: PolicyAnchorUnreachable,
		},
		{
			name:        "no anchor yet is non-fatal (pre-MVP)",
			found:       false,
			wantVerdict: PolicyAnchorAbsent,
		},
		{
			name:            "matching hash verifies",
			anchoredVersion: localVersion,
			anchoredHash:    localHash,
			found:           true,
			wantVerdict:     PolicyAnchorVerified,
		},
		{
			name:            "hash compare is case-insensitive and whitespace-tolerant",
			anchoredVersion: localVersion,
			anchoredHash:    "  abc123def  ",
			found:           true,
			wantVerdict:     PolicyAnchorVerified,
		},
		{
			name:            "mismatched hash is FATAL",
			anchoredVersion: localVersion,
			anchoredHash:    "deadbeef",
			found:           true,
			wantVerdict:     PolicyAnchorMismatch,
			wantFatal:       true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			verdict, fatal := PolicyAnchorVerdict(localVersion, localHash, tc.anchoredVersion, tc.anchoredHash, tc.found, tc.queryErr)
			if verdict != tc.wantVerdict {
				t.Fatalf("verdict: got %q want %q", verdict, tc.wantVerdict)
			}
			if fatal != tc.wantFatal {
				t.Fatalf("fatal: got %v want %v", fatal, tc.wantFatal)
			}
		})
	}
}
