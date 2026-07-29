package chain

import (
	"context"
	"encoding/hex"
	"strings"
	"time"

	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
)

const (
	PolicyAnchorVerified    = "anchor_verified"
	PolicyAnchorAbsent      = "anchor_absent"
	PolicyAnchorUnreachable = "anchor_unreachable"
	PolicyAnchorMismatch    = "anchor_mismatch"
)

func (c *GrpcClient) LatestPolicyAnchor(ctx context.Context) (version string, policyHashHex string, found bool, err error) {
	if c == nil || c.serveQuery == nil {
		return "", "", false, nil
	}

	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	resp, err := c.serveQuery.GetLatestPolicyAnchor(ctx, &servetypes.QueryGetLatestPolicyAnchorRequest{})
	if err != nil {
		if c.isNotFound(err) {
			return "", "", false, nil
		}
		return "", "", false, err
	}
	if resp == nil || !resp.GetFound() || resp.GetAnchor() == nil {
		return "", "", false, nil
	}

	anchor := resp.GetAnchor()
	return anchor.GetPolicyVersion(), hex.EncodeToString(anchor.GetPolicyHash()), true, nil
}

func PolicyAnchorVerdict(localVersion, localHash, anchoredVersion, anchoredHash string, found bool, queryErr error) (verdict string, fatal bool) {
	_ = localVersion
	_ = anchoredVersion
	if queryErr != nil {
		return PolicyAnchorUnreachable, false
	}
	if !found {
		return PolicyAnchorAbsent, false
	}
	if !strings.EqualFold(strings.TrimSpace(localHash), strings.TrimSpace(anchoredHash)) {
		return PolicyAnchorMismatch, true
	}
	return PolicyAnchorVerified, false
}
