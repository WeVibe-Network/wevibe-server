package chain

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	abcitypes "github.com/cometbft/cometbft/abci/types"
	"github.com/cometbft/cometbft/crypto/tmhash"
	coretypes "github.com/cometbft/cometbft/rpc/core/types"
	cmttypes "github.com/cometbft/cometbft/types"
	"github.com/cosmos/cosmos-sdk/codec"
	sdk "github.com/cosmos/cosmos-sdk/types"
	authtx "github.com/cosmos/cosmos-sdk/x/auth/tx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	memorytypes "github.com/wevibe-network/wevibe-chain/x/memory/types"
	orgtypes "github.com/wevibe-network/wevibe-chain/x/org/types"
	reputationtypes "github.com/wevibe-network/wevibe-chain/x/reputation/types"
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
)

type ChainWatcher struct {
	chainClient  *GrpcClient
	db           *pgxpool.Pool
	logger       *slog.Logger
	subscriber   *CometBFTSubscriber
	txDecoder    TxDecoderFunc
	notifHub     *notifications.NotificationHub
	dispatcher   *notifications.Dispatcher
	qdrantClient *retrieval.QdrantClient
	embedURL     string
}

type TxDecoderFunc func(txBytes []byte) (TxInterface, error)

type TxInterface interface {
	GetMsgs() []interface{}
}

type sdkTxAdapter struct {
	tx sdk.Tx
}

func (a sdkTxAdapter) GetMsgs() []interface{} {
	msgs := a.tx.GetMsgs()
	out := make([]interface{}, len(msgs))
	for i := range msgs {
		out[i] = msgs[i]
	}
	return out
}

// BuildTxDecoder reuses the GrpcClient proto codec/registry so tx decoding
// stays aligned with the single chain module registration path.
func BuildTxDecoder(cdc codec.Codec) TxDecoderFunc {
	if cdc == nil {
		return func(txBytes []byte) (TxInterface, error) {
			return nil, fmt.Errorf("tx decoder codec is nil")
		}
	}

	txConfig := authtx.NewTxConfig(cdc, authtx.DefaultSignModes)
	decoder := txConfig.TxDecoder()

	return func(txBytes []byte) (TxInterface, error) {
		tx, err := decoder(txBytes)
		if err != nil {
			return nil, err
		}
		if tx == nil {
			return nil, fmt.Errorf("decoded tx is nil")
		}
		return sdkTxAdapter{tx: tx}, nil
	}
}

func NewChainWatcher(chainClient *GrpcClient, db *pgxpool.Pool, logger *slog.Logger, txDecoder TxDecoderFunc, notifHub *notifications.NotificationHub, qdrantClient *retrieval.QdrantClient, embedURL string) *ChainWatcher {
	return &ChainWatcher{
		chainClient:  chainClient,
		db:           db,
		logger:       logger,
		txDecoder:    txDecoder,
		notifHub:     notifHub,
		qdrantClient: qdrantClient,
		embedURL:     embedURL,
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

	// CO-021: ensure the CometBFT subscriber is initialized BEFORE catchUp.
	// catchUp dereferences w.subscriber; the previous code only created it
	// inside subscribe() further down, which made any hot-restart (last_seen
	// > 0) nilptr-panic the hub into a crash-loop.
	if err := w.ensureSubscriber(ctx); err != nil {
		return fmt.Errorf("init subscriber: %w", err)
	}

	if lastHeight > 0 {
		if err := w.catchUp(ctx, lastHeight); err != nil {
			w.logger.Error("catchUp failed", "err", err, "lastHeight", lastHeight)
		}
	}

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

func (w *ChainWatcher) ensureSubscriber(ctx context.Context) error {
	if w.subscriber != nil {
		return nil
	}
	// CO-021: was previously hardcoded to "tcp://localhost:26657", which
	// fails inside Docker where the hub container cannot reach the chain
	// over localhost. The grpc client already reads the chain endpoint
	// from WEVIBE_CHAIN_RPC_URL; the subscriber must use the same source.
	nodeURL := strings.TrimSpace(os.Getenv("WEVIBE_CHAIN_RPC_URL"))
	if nodeURL == "" {
		nodeURL = "tcp://localhost:26657"
	}
	sub, err := NewCometBFTSubscriber(nodeURL, w.logger)
	if err != nil {
		return fmt.Errorf("create cometbft subscriber: %w", err)
	}
	if err := sub.Start(ctx); err != nil {
		return fmt.Errorf("start cometbft subscriber: %w", err)
	}
	w.subscriber = sub
	return nil
}

func (w *ChainWatcher) subscribe(ctx context.Context) (<-chan coretypes.ResultEvent, error) {
	if err := w.ensureSubscriber(ctx); err != nil {
		return nil, err
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
		blockResults, err := w.subscriber.BlockResults(ctx, &h)
		if err != nil {
			return fmt.Errorf("fetch block results %d: %w", h, err)
		}
		if blockResults == nil {
			return fmt.Errorf("fetch block results %d: empty result", h)
		}

		if err := w.processBlock(ctx, block, blockResults.TxsResults); err != nil {
			return fmt.Errorf("process block %d: %w", h, err)
		}
	}
	return nil
}

func (w *ChainWatcher) computeEmbedding(ctx context.Context, keywords []string) ([]float32, error) {
	if len(keywords) == 0 {
		return make([]float32, embed.EMBED_DIM), nil
	}
	combinedText := strings.Join(keywords, " ")
	vector, err := embed.GetEmbedding(ctx, w.embedURL, combinedText)
	if err != nil || len(vector) == 0 {
		return make([]float32, embed.EMBED_DIM), nil
	}
	return vector, nil
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
	return w.processBlock(ctx, blockEvent.Block, blockEvent.ResultFinalizeBlock.TxResults)
}

func (w *ChainWatcher) processBlock(ctx context.Context, block *cmttypes.Block, txResults []*abcitypes.ExecTxResult) error {
	if block == nil {
		return fmt.Errorf("nil block")
	}
	if len(txResults) != len(block.Txs) {
		return fmt.Errorf("tx results mismatch at height %d: txs=%d tx_results=%d", block.Height, len(block.Txs), len(txResults))
	}

	height := block.Height
	timestamp := block.Time

	for idx, txBytes := range block.Txs {
		txHash := tmhash.Sum(txBytes)
		txResult := txResults[idx]
		if txResult == nil {
			w.logger.Warn("skipping tx with missing execution result",
				"height", height,
				"tx_index", idx,
				"tx_hash", fmt.Sprintf("%X", txHash))
			continue
		}
		if txResult.Code != 0 {
			w.logger.Debug("skipping failed tx",
				"height", height,
				"tx_index", idx,
				"tx_hash", fmt.Sprintf("%X", txHash),
				"code", txResult.Code,
				"codespace", txResult.Codespace,
				"log", txResult.Log)
			continue
		}

		if err := w.processTx(ctx, txHash, height, timestamp, txBytes); err != nil {
			w.logger.Error("process tx failed", "tx_hash", fmt.Sprintf("%X", txHash), "err", err)
		}
	}

	return w.updateLastSeenBlock(ctx, height)
}

func (w *ChainWatcher) processTx(ctx context.Context, txHash []byte, height int64, timestamp time.Time, txBytes []byte) error {
	// tx decoding is required for all watcher bookkeeping paths; if decoder
	// wiring is missing, fail fast instead of silently skipping the tx.
	if w.txDecoder == nil {
		return fmt.Errorf("tx decoder is not initialized")
	}

	decoded, err := w.txDecoder(txBytes)
	if err != nil {
		return fmt.Errorf("decode tx: %w", err)
	}

	txHashHex := fmt.Sprintf("%X", txHash)
	allMsgs := decoded.GetMsgs()

	for _, msg := range allMsgs {
		switch m := msg.(type) {
		case *memorytypes.MsgApproveMemory:
			var keywords []string
			var contributorID, contributorWallet string
			for _, innerMsg := range allMsgs {
				if sc, ok := innerMsg.(*memorytypes.MsgSubmitCommitment); ok {
					if sc.OrgId == m.OrgId && string(sc.ContentHash) == string(m.ContentHash) {
						keywords = make([]string, len(sc.Keywords))
						for i, kw := range sc.Keywords {
							keywords[i] = kw.Keyword
						}
						contributorID = sc.ContributorId
						contributorWallet = sc.ContributorWallet
						break
					}
				}
			}

			if err := w.processApproveMemoryBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.ContentHash, keywords, contributorID, contributorWallet,
				m.MemoryType.String(), m.EncryptedBlob, m.WrappedDekEnc); err != nil {
				w.logger.Error("processApproveMemoryBookkeeping failed", "err", err, "org_id", m.OrgId)
			}

		case *memorytypes.MsgReportMemory:
			if err := w.processReportBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.ContentHash, m.ReporterPubkey); err != nil {
				w.logger.Error("processReportBookkeeping failed", "err", err, "org_id", m.OrgId)
			}

		case *servetypes.MsgSubmitServeBatch:
			serves := make([]ServeEntry, len(m.Serves))
			for i, s := range m.Serves {
				serves[i] = ServeEntry{
					MemoryContentHash: s.MemoryContentHash,
					ContributorWallet: s.ContributorWallet,
					ServeCount:        uint64(s.TurnCount),
					Nullifier:         hex.EncodeToString(s.Nullifier),
					ModelID:           s.ModelId,
				}
			}
			if err := w.processServeBatchBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Epoch, serves); err != nil {
				w.logger.Error("processServeBatchBookkeeping failed", "err", err, "org_id", m.OrgId)
			}

		case *servetypes.MsgSubmitDenialBatch:
			denials := make([]DenialEntry, len(m.Entries))
			for i, d := range m.Entries {
				denials[i] = DenialEntry{
					MemoryContentHash: d.MemoryHash,
					ContributorWallet: d.DenyKey,
					DenialCount:       1,
				}
			}
			if err := w.processDenialBatchBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Epoch, denials); err != nil {
				w.logger.Error("processDenialBatchBookkeeping failed", "err", err, "org_id", m.OrgId)
			}

		case *orgtypes.MsgAddMember:
			if err := w.processAddMemberBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey, m.Role); err != nil {
				w.logger.Error("processAddMemberBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *orgtypes.MsgUpdateMemberRole:
			if err := w.processUpdateMemberRoleBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey, m.NewRole); err != nil {
				w.logger.Error("processUpdateMemberRoleBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *orgtypes.MsgRemoveMember:
			if err := w.processRemoveMemberBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey); err != nil {
				w.logger.Error("processRemoveMemberBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *memorytypes.MsgSubmitCommitment,
			*reputationtypes.MsgIncrementContribution,
			*reputationtypes.MsgIncrementServe,
			*reputationtypes.MsgRecordBan,
			*orgtypes.MsgSetOrgConfig:
			w.logger.Debug("processed msg type with no bookkeeping", "msg_type", fmt.Sprintf("%T", msg))
		}
	}
	return nil
}

func (w *ChainWatcher) processUpdateMemberRoleBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string, newRole string) error {
	var oldRole string
	err := w.db.QueryRow(ctx, `
		SELECT role
		FROM members
		WHERE org_id = $1 AND pubkey = $2
	`, orgID, pubkey).Scan(&oldRole)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("failed to fetch current member role: %w", err)
	}

	tag, err := w.db.Exec(ctx, `
		UPDATE members
		SET role = $1,
		    updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3
	`, newRole, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("failed to update member role: %w", err)
	}
	if tag.RowsAffected() == 0 {
		w.logger.Warn("member row not found during update-member-role bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash)
		return nil
	}

	wasContributor := oldRole == "contributor"
	isContributor := newRole == "contributor"
	if wasContributor == isContributor {
		return nil
	}

	orgLabel := orgID
	var orgName string
	err = w.db.QueryRow(ctx, `
		SELECT org_name
		FROM orgs
		WHERE org_id = $1
	`, orgID).Scan(&orgName)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			w.logger.Warn("failed to load org name for contributor role notification",
				"org_id", orgID,
				"pubkey", pubkey,
				"tx_hash", txHash,
				"err", err)
		}
	} else if orgName != "" {
		orgLabel = orgName
	}

	category := "contributor_revoked"
	title := "Contributor access revoked"
	body := fmt.Sprintf("Your contributor access to %s has been revoked.", orgLabel)
	if isContributor {
		category = "contributor_promoted"
		title = "Promoted to Contributor"
		body = fmt.Sprintf("You can now contribute memories to %s.", orgLabel)
	}

	if err := notifications.EmitUserNotification(
		ctx,
		w.db,
		w.notifHub,
		w.dispatcher,
		pubkey,
		category,
		title,
		body,
		txHash,
		orgID,
	); err != nil {
		return fmt.Errorf("failed to emit contributor role notification: %w", err)
	}

	return nil
}

func (w *ChainWatcher) processRemoveMemberBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string) error {
	tag, err := w.db.Exec(ctx, `
		UPDATE members
		SET active = false,
		    updated_at = NOW()
		WHERE org_id = $1 AND pubkey = $2
	`, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("failed to mark member inactive: %w", err)
	}
	if tag.RowsAffected() == 0 {
		w.logger.Warn("member row not found during remove-member bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash)
	}

	return nil
}

func (w *ChainWatcher) processAddMemberBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string, role string) error {
	tag, err := w.db.Exec(ctx, `
		UPDATE members
		SET role = $1,
		    updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3
	`, role, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("failed to sync added member role: %w", err)
	}
	if tag.RowsAffected() == 0 {
		w.logger.Warn("member row not found during add-member bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash)
	}

	return nil
}

func (w *ChainWatcher) getLastSeenBlock(ctx context.Context) (int64, error) {
	var lastHeight int64
	err := w.db.QueryRow(ctx, `SELECT last_seen_block_height FROM watcher_state WHERE watcher_name = 'chain_watcher'`).Scan(&lastHeight)
	if err != nil {
		return 0, err
	}
	return lastHeight, nil
}

func (w *ChainWatcher) updateLastSeenBlock(ctx context.Context, height int64) error {
	_, err := w.db.Exec(ctx, `UPDATE watcher_state SET last_seen_block_height = $1, updated_at = NOW() WHERE watcher_name = 'chain_watcher'`, height)
	return err
}
