package chain

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

func (w *ChainWatcher) RedriveApproveMemory(ctx context.Context, orgID string, contentHashHex string) error {
	return w.redriveApproveMemory(ctx, orgID, contentHashHex,
		func(ctx context.Context, orgID, contentHashHex string) (string, error) {
			var status string
			err := w.db.QueryRow(ctx, `
				SELECT status
				FROM pending_submissions
				WHERE org_id = $1 AND submission_hash = $2
			`, orgID, contentHashHex).Scan(&status)
			return status, err
		},
		func(ctx context.Context, query string, page, perPage int) (*coretypes.ResultTxSearch, error) {
			if err := w.ensureSubscriber(ctx); err != nil {
				return nil, err
			}
			return w.subscriber.client.TxSearch(ctx, query, false, &page, &perPage, "desc")
		},
		func(ctx context.Context, height int64) (time.Time, error) {
			if err := w.ensureSubscriber(ctx); err != nil {
				return time.Time{}, err
			}
			block, err := w.subscriber.Block(ctx, &height)
			if err != nil {
				return time.Time{}, err
			}
			if block == nil {
				return time.Time{}, fmt.Errorf("block %d not found", height)
			}
			return block.Time, nil
		},
		w.txDecoder,
		w.processApproveMemoryBookkeeping,
	)
}

func (w *ChainWatcher) redriveApproveMemory(ctx context.Context, orgID string, contentHashHex string,
	loadStatus func(context.Context, string, string) (string, error),
	txSearch func(context.Context, string, int, int) (*coretypes.ResultTxSearch, error),
	blockTime func(context.Context, int64) (time.Time, error),
	decode TxDecoderFunc,
	bookkeep func(context.Context, string, int64, time.Time, string, []byte, []string, string, string, string, []byte, []byte, uint32) error,
) error {
	start := time.Now()
	contentFP := ""
	outcome := "error"
	defer func() {
		if outcome == "" {
			return
		}
		wlog.Op(ctx, "chain.redrive", slog.LevelInfo,
			slog.String("org_fp", wlog.Fingerprint([]byte(orgID))),
			slog.String("content_fp", contentFP),
			slog.String("outcome", outcome),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()
	if wlog.TraceFromContext(ctx) == "" {
		ctx = wlog.WithTrace(ctx, uuid.NewString())
	}

	contentHashHex = strings.ToLower(strings.TrimSpace(contentHashHex))
	contentHash, err := hex.DecodeString(contentHashHex)
	if err != nil {
		return fmt.Errorf("decode content hash: %w", err)
	}
	contentFP = contentHashHex
	if len(contentFP) > 8 {
		contentFP = contentFP[:8]
	}

	status, err := loadStatus(ctx, orgID, contentHashHex)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("pending_submission not found for org=%s content_hash=%s", orgID, contentHashHex)
		}
		return fmt.Errorf("load pending_submission status: %w", err)
	}
	if status == protocol.SubmissionStatusCommitted {
		outcome = "noop_already_committed"
		return nil
	}

	if decode == nil {
		return fmt.Errorf("tx decoder is not initialized")
	}

	const query = "message.action='/wevibe.memory.v1.MsgApproveMemory'"
	page, perPage := 1, 100
	for {
		result, err := txSearch(ctx, query, page, perPage)
		if err != nil {
			return fmt.Errorf("tx search page %d: %w", page, err)
		}
		for _, tx := range result.Txs {
			decoded, err := decode(tx.Tx)
			if err != nil {
				return fmt.Errorf("decode tx %X: %w", []byte(tx.Hash), err)
			}
			msgs := decoded.GetMsgs()
			for _, msg := range msgs {
				approve, ok := msg.(*memorytypes.MsgApproveMemory)
				if !ok || approve.OrgId != orgID || !bytes.Equal(approve.ContentHash, contentHash) {
					continue
				}
				var keywords []string
				var contributorID, contributorWallet string
				for _, inner := range msgs {
					submit, ok := inner.(*memorytypes.MsgSubmitCommitment)
					if !ok || submit.OrgId != approve.OrgId || !bytes.Equal(submit.ContentHash, approve.ContentHash) {
						continue
					}
					keywords = make([]string, len(submit.Keywords))
					for i, kw := range submit.Keywords {
						keywords[i] = kw.Keyword
					}
					contributorID = submit.ContributorId
					contributorWallet = submit.ContributorWallet
					break
				}
				txTime, err := blockTime(ctx, tx.Height)
				if err != nil {
					return fmt.Errorf("load tx block time (height=%d): %w", tx.Height, err)
				}
				if err := bookkeep(ctx, fmt.Sprintf("%X", []byte(tx.Hash)), tx.Height, txTime,
					approve.OrgId, approve.ContentHash, keywords, contributorID, contributorWallet,
					approve.MemoryType.String(), approve.EncryptedBlob, approve.WrappedDekEnc, approve.McVersion); err != nil {
					return fmt.Errorf("process approve bookkeeping: %w", err)
				}
				outcome = "healed"
				return nil
			}
		}
		if page*perPage >= result.TotalCount {
			break
		}
		page++
	}

	return fmt.Errorf("no mined MsgApproveMemory found for org=%s content_hash=%s", orgID, contentHashHex)
}
