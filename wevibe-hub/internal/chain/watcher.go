package chain

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/cometbft/cometbft/crypto/tmhash"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
)

type ChainWatcher struct {
	chainClient *GrpcClient
	db          *pgxpool.Pool
	logger      *slog.Logger
	subscriber  *CometBFTSubscriber
	txDecoder   TxDecoderFunc
	notifHub    *notifications.NotificationHub
	dispatcher  *notifications.Dispatcher
}

type TxDecoderFunc func(txBytes []byte) (TxInterface, error)

type TxInterface interface {
	GetMsgs() []interface{}
}

func NewChainWatcher(chainClient *GrpcClient, db *pgxpool.Pool, logger *slog.Logger, notifHub *notifications.NotificationHub) *ChainWatcher {
	return &ChainWatcher{
		chainClient: chainClient,
		db:          db,
		logger:      logger,
		notifHub:    notifHub,
	}
}

func (w *ChainWatcher) SetDispatcher(dispatcher *notifications.Dispatcher) {
	w.dispatcher = dispatcher
}

func (w *ChainWatcher) Start(ctx context.Context) error {
	w.logger.Info("chain watcher starting")

	lastHeight, err := w.getLastSeenBlock(ctx)
	if err != nil {
		w.logger.Warn("could not get last seen block, starting from 0", "err", err)
		lastHeight = 0
	}
	w.logger.Info("chain watcher resuming", "last_height", lastHeight)

	eventCh, err := w.subscribe(ctx)
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("chain watcher shutting down")
			return nil
		case event, ok := <-eventCh:
			if !ok {
				w.logger.Warn("subscription channel closed; reconnecting")
				if err := w.reconnect(ctx); err != nil {
					return fmt.Errorf("reconnect failed: %w", err)
				}
				eventCh, err = w.subscribe(ctx)
				if err != nil {
					return err
				}
				continue
			}
			if err := w.processBlockEvent(ctx, event); err != nil {
				w.logger.Error("process block failed", "err", err)
			}
		}
	}
}

func (w *ChainWatcher) subscribe(ctx context.Context) (<-chan coretypes.ResultEvent, error) {
	if w.subscriber == nil {
		nodeURL := "tcp://localhost:26657"
		sub, err := NewCometBFTSubscriber(nodeURL, w.logger)
		if err != nil {
			return nil, fmt.Errorf("create cometbft subscriber: %w", err)
		}
		if err := sub.Start(ctx); err != nil {
			return nil, fmt.Errorf("start cometbft subscriber: %w", err)
		}
		w.subscriber = sub
	}
	return w.subscriber.Subscribe(ctx)
}

func (w *ChainWatcher) catchUp(ctx context.Context, lastSeen int64) error {
	statusResp, err := w.subscriber.Status(ctx)
	if err != nil {
		return fmt.Errorf("get status: %w", err)
	}
	currentHeight := statusResp.SyncInfo.LatestBlockHeight

	if currentHeight <= lastSeen {
		return nil
	}

	w.logger.Info("catching up", "from", lastSeen+1, "to", currentHeight)
	for h := lastSeen + 1; h <= currentHeight; h++ {
		block, err := w.subscriber.Block(ctx, &h)
		if err != nil {
			return fmt.Errorf("fetch block %d: %w", h, err)
		}
		if err := w.processBlock(ctx, block); err != nil {
			return fmt.Errorf("process block %d: %w", h, err)
		}
	}
	return nil
}

func (w *ChainWatcher) reconnect(ctx context.Context) error {
	backoff := time.Second
	maxBackoff := 30 * time.Second

	for attempt := 0; attempt < 10; attempt++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}

		newSub, err := NewCometBFTSubscriber(w.subscriber.nodeURL, w.logger)
		if err == nil {
			if err := newSub.Start(ctx); err == nil {
				w.subscriber = newSub
				w.logger.Info("watcher reconnected", "attempt", attempt+1)
				return nil
			}
		}

		w.logger.Warn("reconnect attempt failed", "attempt", attempt+1, "err", err)
		backoff = backoff * 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
	return fmt.Errorf("reconnect failed after 10 attempts")
}

func (w *ChainWatcher) processBlockEvent(ctx context.Context, event coretypes.ResultEvent) error {
	blockEvent, ok := event.Data.(cmttypes.EventDataNewBlock)
	if !ok {
		return fmt.Errorf("unexpected event data type")
	}
	return w.processBlock(ctx, blockEvent.Block)
}

func (w *ChainWatcher) processBlock(ctx context.Context, block *cmttypes.Block) error {
	height := block.Height
	timestamp := block.Time

	for _, txBytes := range block.Txs {
		txHash := tmhash.Sum(txBytes)
		if err := w.processTx(ctx, txHash, height, timestamp, txBytes); err != nil {
			w.logger.Error("process tx failed", "tx_hash", fmt.Sprintf("%X", txHash), "err", err)
		}
	}

	return w.updateLastSeenBlock(ctx, height)
}

func (w *ChainWatcher) processTx(ctx context.Context, txHash []byte, height int64, timestamp time.Time, txBytes []byte) error {
	decoded, err := w.txDecoder(txBytes)
	if err != nil {
		return fmt.Errorf("decode tx: %w", err)
	}

	for _, msg := range decoded.GetMsgs() {
		switch m := msg.(type) {
		case *memorytypes.MsgApproveMemory:
			event := MemoryApprovedEvent{
				OrgID:             m.OrgId,
				ContentHash:       m.ContentHash,
				ContributorPubkey: m.Signer,
				Approvers:         m.Approvers,
				CommittingLeader:  m.CommittingLeader,
				EncryptedBlob:     m.EncryptedBlob,
				MemoryType:        m.MemoryType.String(),
			}
			if err := w.processApproveEvent(ctx, fmt.Sprintf("%X", txHash), height, timestamp, event); err != nil {
				return err
			}
		case *memorytypes.MsgReportMemory:
			event := ReportUpheldEvent{
				OrgID:               m.OrgId,
				ContentHash:         m.ContentHash,
				ContributorPubkey:   m.ContributorPubkey,
				ApprovingModerators: m.ApprovingModerators,
				UpholdingModerators: m.UpholdingModerators,
				ReporterPubkey:      m.ReporterPubkey,
				Reason:              m.Reason,
			}
			if err := w.processReportEvent(ctx, fmt.Sprintf("%X", txHash), height, timestamp, event); err != nil {
				return err
			}
		}
	}
	return nil
}

func (w *ChainWatcher) getLastSeenBlock(ctx context.Context) (int64, error) {
	var lastHeight int64
	err := w.db.QueryRow(ctx, `SELECT last_seen_block_height FROM watcher_state WHERE watcher_name = 'chain_commit_events'`).Scan(&lastHeight)
	if err != nil {
		return 0, err
	}
	return lastHeight, nil
}

func (w *ChainWatcher) updateLastSeenBlock(ctx context.Context, height int64) error {
	_, err := w.db.Exec(ctx, `UPDATE watcher_state SET last_seen_block_height = $1, updated_at = NOW() WHERE watcher_name = 'chain_commit_events'`, height)
	return err
}

func (w *ChainWatcher) emitModeratorNotifications(ctx context.Context, moderators []string, orgID, category, title, body, eventRef string) error {
	var orgName string
	_ = w.db.QueryRow(ctx, `SELECT org_name FROM orgs WHERE org_id = $1`, orgID).Scan(&orgName)

	for _, modPubkey := range moderators {
		var notifID int64
		var createdAt time.Time
		err := w.db.QueryRow(ctx, `
			INSERT INTO notifications
				(recipient_pubkey, category, title, body, event_ref, org_id, created_at)
			VALUES ($1, $2, $3, $4, $5, $6, NOW())
			RETURNING id, created_at
		`, modPubkey, category, title, body, eventRef, orgID).Scan(&notifID, &createdAt)
		if err != nil {
			w.logger.Error("failed to emit notification", "err", err, "recipient", modPubkey)
			continue
		}

		if w.notifHub != nil {
			payload := notifications.NotificationPayload{
				ID:        notifID,
				Category:  category,
				Title:     title,
				Body:      body,
				EventRef:  eventRef,
				OrgID:     orgID,
				OrgName:   orgName,
				Read:      false,
				CreatedAt: createdAt.Format(time.RFC3339),
			}
			if data, err := notifications.NewNotificationMessage(&payload); err == nil {
				w.notifHub.Broadcast(modPubkey, data)
			}
		}

		if w.dispatcher != nil {
			_ = w.dispatcher.Dispatch(ctx, notifications.DispatchEvent{
				RecipientPubkey: modPubkey,
				Category:        category,
				Title:           title,
				Body:            body,
				EventRef:        eventRef,
				OrgID:           orgID,
				OrgName:         orgName,
				CreatedAt:       createdAt,
			})
		}
	}
	return nil
}

func (w *ChainWatcher) processApproveEvent(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, event MemoryApprovedEvent) error {
	_, err := w.db.Exec(ctx, `
		INSERT INTO chain_commit_events
			(tx_hash, block_height, block_timestamp, action_type, org_id, memory_hash,
			 contributor_pubkey, approving_moderators, committing_leader_pubkey, raw_msg_json)
		VALUES ($1, $2, $3, 'memory_approved', $4, $5, $6, $7, $8, $9)
		ON CONFLICT (tx_hash, memory_hash) DO NOTHING
	`, txHash, blockHeight, blockTime, event.OrgID, event.ContentHash, event.ContributorPubkey,
		event.Approvers, event.CommittingLeader, "[]")
	if err != nil {
		return err
	}

	w.emitModeratorNotifications(ctx, event.Approvers, event.OrgID,
		"chain_commit_involving_you",
		"You were listed as approver on a chain commit",
		fmt.Sprintf("Memory %x was committed to chain in org %s by leader %s", event.ContentHash[:8], event.OrgID, event.CommittingLeader),
		txHash)

	return nil
}

func (w *ChainWatcher) processReportEvent(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, event ReportUpheldEvent) error {
	rawJSON, _ := json.Marshal(event)
	_, err := w.db.Exec(ctx, `
		INSERT INTO chain_commit_events
			(tx_hash, block_height, block_timestamp, action_type, org_id, memory_hash,
			 contributor_pubkey, approving_moderators, upholding_moderators,
			 committing_leader_pubkey, reporter_pubkey, raw_msg_json)
		VALUES ($1, $2, $3, 'report_upheld', $4, $5, $6, $7, $8, $9, $10, $11)
		ON CONFLICT (tx_hash, memory_hash) DO NOTHING
	`, txHash, blockHeight, blockTime, event.OrgID, event.ContentHash, event.ContributorPubkey,
		event.ApprovingModerators, event.UpholdingModerators,
		"", event.ReporterPubkey, rawJSON)
	if err != nil {
		return err
	}

	w.emitModeratorNotifications(ctx, event.UpholdingModerators, event.OrgID,
		"report_upheld_committed",
		"Report you voted to uphold was committed to chain",
		fmt.Sprintf("Memory %x was deleted via upheld report in org %s by leader", event.ContentHash[:8], event.OrgID),
		txHash)

	w.emitModeratorNotifications(ctx, event.ApprovingModerators, event.OrgID,
		"your_approval_was_overturned",
		"A memory you approved was deleted via upheld report",
		fmt.Sprintf("Memory %x you approved was deleted via upheld report in org %s", event.ContentHash[:8], event.OrgID),
		txHash)

	return nil
}

type MemoryApprovedEvent struct {
	OrgID             string   `json:"org_id"`
	ContentHash       []byte   `json:"content_hash"`
	ContributorPubkey string   `json:"contributor_pubkey"`
	Approvers         []string `json:"approvers"`
	CommittingLeader  string   `json:"committing_leader"`
	EncryptedBlob     []byte   `json:"encrypted_blob"`
	MemoryType        string   `json:"memory_type"`
}

type ReportUpheldEvent struct {
	OrgID               string   `json:"org_id"`
	ContentHash         []byte   `json:"content_hash"`
	ContributorPubkey   string   `json:"contributor_pubkey"`
	ApprovingModerators []string `json:"approving_moderators"`
	UpholdingModerators []string `json:"upholding_moderators"`
	ReporterPubkey      string   `json:"reporter_pubkey"`
	Reason              string   `json:"reason"`
}
