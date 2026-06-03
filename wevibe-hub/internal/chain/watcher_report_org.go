package chain

import (
	"context"
	"encoding/hex"
	"fmt"
	"time"
)

func (w *ChainWatcher) processReportBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, contentHash []byte, reporterPubkey string) error {
	memoryCID := hex.EncodeToString(contentHash)

	_, err := w.db.Exec(ctx, `
		UPDATE reports
		SET status = 'upheld',
		    resolution = 'upheld',
		    tx_hash = $1,
		    resolved_at = NOW(),
		    updated_at = NOW()
		WHERE org_id = $2
		  AND memory_cid = $3
		  AND status IN ('upheld_pending_tx', 'under_review')
	`, txHash, orgID, memoryCID)
	if err != nil {
		return fmt.Errorf("failed to update report status: %w", err)
	}

	err = w.qdrantClient.DeletePointByCID(ctx, orgID, memoryCID)
	if err != nil {
		w.logger.Warn("failed to delete qdrant point",
			"org_id", orgID,
			"memory_cid", memoryCID,
			"error", err)
	}

	_, err = w.db.Exec(ctx, `
		UPDATE pending_submissions
		SET banned = true,
		    status = 'denied',
		    denial_reason = 'memory_upheld_report',
		    updated_at = NOW()
		WHERE org_id = $1
		  AND submission_hash = $2
	`, orgID, txHash)
	if err != nil {
		return fmt.Errorf("failed to update pending submission: %w", err)
	}

	return nil
}
