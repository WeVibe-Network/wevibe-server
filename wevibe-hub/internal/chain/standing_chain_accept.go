package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"log/slog"

	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

func chainAcceptedOutcomeFingerprints(ctx context.Context, chainClient *GrpcClient, orgID string, epoch uint64) (map[string]bool, error) {
	if chainClient == nil {
		return nil, fmt.Errorf("chain client unavailable")
	}
	serveQuery := chainClient.GetServeQueryClient()
	if serveQuery == nil {
		return nil, fmt.Errorf("serve query client unavailable")
	}

	resp, err := serveQuery.ListEvents(ctx, &servetypes.QueryListEventsRequest{OrgId: orgID, Epoch: epoch})
	if err != nil {
		return nil, fmt.Errorf("list chain events org=%s epoch=%d: %w", orgID, epoch, err)
	}

	accepted := make(map[string]bool)
	for _, event := range resp.GetEvents() {
		if event == nil || event.GetEventType() != servetypes.EventType_EVENT_TYPE_OUTCOME {
			continue
		}
		fp := event.GetFingerprint()
		if len(fp) == 0 {
			continue
		}
		accepted[hex.EncodeToString(fp)] = true
	}

	wlog.Op(ctx, "chain.accept_filter", slog.LevelInfo,
		slog.String("org", orgID),
		slog.Uint64("epoch", epoch),
		slog.Int("count", len(accepted)))
	return accepted, nil
}
