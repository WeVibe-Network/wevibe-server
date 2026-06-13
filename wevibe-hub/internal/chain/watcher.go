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
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/envelopes"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/notifications"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/retrieval"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/umbral"
)

type ChainWatcher struct {
	chainClient   *GrpcClient
	db            *pgxpool.Pool
	logger        *slog.Logger
	subscriber    *CometBFTSubscriber
	txDecoder     TxDecoderFunc
	notifHub      *notifications.NotificationHub
	dispatcher    *notifications.Dispatcher
	qdrantClient  *retrieval.QdrantClient
	embedURL      string
	umbralService *umbral.Service
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

func NewChainWatcher(chainClient *GrpcClient, db *pgxpool.Pool, logger *slog.Logger, txDecoder TxDecoderFunc, notifHub *notifications.NotificationHub, qdrantClient *retrieval.QdrantClient, embedURL string, umbralService *umbral.Service) *ChainWatcher {
	return &ChainWatcher{
		chainClient:   chainClient,
		db:            db,
		logger:        logger,
		txDecoder:     txDecoder,
		notifHub:      notifHub,
		qdrantClient:  qdrantClient,
		embedURL:      embedURL,
		umbralService: umbralService,
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
					Fingerprint:       hex.EncodeToString(servetypes.ComputeServeFingerprint(s.MemoryContentHash, s.ServeKeyPubkey, m.Epoch)),
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
					DenialCount:       1,
				}
			}
			if err := w.processDenialBatchBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Epoch, denials); err != nil {
				w.logger.Error("processDenialBatchBookkeeping failed", "err", err, "org_id", m.OrgId)
			}

		case *orgtypes.MsgAddMember:
			if err := w.processAddMemberBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey, m.X25519Pubkey, m.Role, m.CanContribute, m.CanModerate); err != nil {
				w.logger.Error("processAddMemberBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *orgtypes.MsgSetMemberCapabilities:
			if err := w.processSetMemberCapabilitiesBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey, m.CanContribute, m.CanModerate); err != nil {
				w.logger.Error("processSetMemberCapabilitiesBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *orgtypes.MsgRemoveMember:
			if err := w.processRemoveMemberBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.Pubkey); err != nil {
				w.logger.Error("processRemoveMemberBookkeeping failed", "err", err, "org_id", m.OrgId, "pubkey", m.Pubkey)
			}

		case *orgtypes.MsgTransferLeadership:
			if err := w.processTransferLeadershipBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId, m.NewLeader, m.NewLeaderWallet); err != nil {
				w.logger.Error("processTransferLeadershipBookkeeping failed", "err", err, "org_id", m.OrgId, "new_leader", m.NewLeader)
			}

		case *orgtypes.MsgCloseOrg:
			if err := w.processCloseOrgBookkeeping(ctx, txHashHex, height, timestamp,
				m.OrgId); err != nil {
				w.logger.Error("processCloseOrgBookkeeping failed", "err", err, "org_id", m.OrgId)
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

func (w *ChainWatcher) processSetMemberCapabilitiesBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string, canContribute bool, canModerate bool) error {
	tag, err := w.db.Exec(ctx, `
		UPDATE members
		SET can_contribute = $1,
		    can_moderate = $2,
		    chain_confirmed = TRUE,
		    updated_at = NOW()
		WHERE org_id = $3 AND pubkey = $4
	`, canContribute, canModerate, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("failed to update member capabilities: %w", err)
	}
	if tag.RowsAffected() == 0 {
		w.logger.Warn("member row not found during set-member-capabilities bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash)
	}

	return nil
}

func (w *ChainWatcher) processRemoveMemberBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string) error {
	currentEpoch, err := orgs.GetCurrentEpoch(ctx, w.db, orgID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.logger.Warn("org row not found during remove-member bookkeeping; skipping member deactivation",
				"org_id", orgID,
				"pubkey", pubkey,
				"tx_hash", txHash)
		} else {
			w.logger.Warn("failed to load current epoch during remove-member bookkeeping; skipping member deactivation",
				"org_id", orgID,
				"pubkey", pubkey,
				"tx_hash", txHash,
				"err", err)
		}
	} else {
		if err := members.RemoveMember(ctx, w.db, orgID, pubkey, currentEpoch); err != nil {
			errLower := strings.ToLower(err.Error())
			if errors.Is(err, pgx.ErrNoRows) || strings.Contains(errLower, "not found") || strings.Contains(errLower, "inactive") {
				w.logger.Info("remove-member bookkeeping already applied",
					"org_id", orgID,
					"pubkey", pubkey,
					"tx_hash", txHash,
					"err", err)
			} else {
				w.logger.Warn("failed to mark member inactive during remove-member bookkeeping",
					"org_id", orgID,
					"pubkey", pubkey,
					"tx_hash", txHash,
					"err", err)
			}
		}
	}

	if err := envelopes.Delete(ctx, w.db, orgID, pubkey); err != nil {
		w.logger.Warn("failed to delete key envelope during remove-member bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash,
			"err", err)
	}

	memberPKBytes, err := hex.DecodeString(pubkey)
	if err != nil {
		w.logger.Warn("failed to decode removed member pubkey during remove-member bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash,
			"err", err)
	} else if w.umbralService != nil {
		if _, err := w.umbralService.OnMemberRemoved(ctx, orgID, memberPKBytes); err != nil {
			w.logger.Error("failed to delete kfrags from sidecar during remove-member bookkeeping; manual cleanup required",
				"org_id", orgID,
				"pubkey", pubkey,
				"tx_hash", txHash,
				"err", err)
		}
	}

	if err := orgs.SetRotationPending(ctx, w.db, orgID); err != nil {
		w.logger.Warn("failed to set rotation pending during remove-member bookkeeping",
			"org_id", orgID,
			"pubkey", pubkey,
			"tx_hash", txHash,
			"err", err)
	}

	return nil
}

func (w *ChainWatcher) processAddMemberBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, pubkey string, x25519Pubkey string, role string, canContribute bool, canModerate bool) error {
	tag, err := w.db.Exec(ctx, `
		UPDATE members
		SET role = $1,
		    can_contribute = $2,
		    can_moderate = $3,
		    chain_confirmed = TRUE,
		    active = TRUE,
		    updated_at = NOW()
		WHERE org_id = $4 AND pubkey = $5
	`, role, canContribute, canModerate, orgID, pubkey)
	if err != nil {
		return fmt.Errorf("failed to mark member chain-confirmed: %w", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}

	var (
		requestID       string
		prePubkey       []byte
		approvalTier    *string
		approvalIsTrial bool
	)

	joinReqErr := w.db.QueryRow(ctx, `
		SELECT request_id, pre_pubkey, approval_tier, approval_is_trial
		FROM join_requests
		WHERE org_id = $1 AND requester_pubkey = $2 AND status IN ('confirming', 'pending')
		ORDER BY (status = 'confirming') DESC, requested_at DESC
		LIMIT 1
	`, orgID, pubkey).Scan(&requestID, &prePubkey, &approvalTier, &approvalIsTrial)
	if joinReqErr != nil && !errors.Is(joinReqErr, pgx.ErrNoRows) {
		return fmt.Errorf("failed to load join request for promoted member: %w", joinReqErr)
	}

	var currentEpoch int
	var trialDays int
	if err := w.db.QueryRow(ctx, `
		SELECT current_epoch, COALESCE(trial_days, 7)
		FROM orgs
		WHERE org_id = $1
	`, orgID).Scan(&currentEpoch, &trialDays); err != nil {
		return fmt.Errorf("failed to load org epoch/trial settings: %w", err)
	}

	if joinReqErr == nil {
		if _, err := w.db.Exec(ctx, `
			INSERT INTO members (
				org_id,
				pubkey,
				x25519_pubkey,
				pre_pubkey,
				role,
				can_contribute,
				can_moderate,
				join_epoch,
				member_tier,
				is_trial,
				trial_expires_at,
				chain_confirmed,
				active
			)
			VALUES (
				$1,
				$2,
				$3,
				$4,
				$5,
				$6,
				$7,
				$8,
				COALESCE($9, 'member'),
				$10,
				CASE WHEN $10 THEN NOW() + ($11 * INTERVAL '1 day') ELSE NULL END,
				TRUE,
				TRUE
			)
			ON CONFLICT (org_id, pubkey) DO UPDATE
			SET role = EXCLUDED.role,
			    can_contribute = EXCLUDED.can_contribute,
			    can_moderate = EXCLUDED.can_moderate,
			    chain_confirmed = TRUE,
			    active = TRUE,
			    updated_at = NOW()
		`, orgID, pubkey, x25519Pubkey, prePubkey, role, canContribute, canModerate, currentEpoch, approvalTier, approvalIsTrial, trialDays); err != nil {
			return fmt.Errorf("failed to upsert confirmed member from join request: %w", err)
		}

		if _, err := w.db.Exec(ctx, `
			UPDATE join_requests
			SET status = 'approved',
			    reviewed_at = NOW()
			WHERE request_id = $1
		`, requestID); err != nil {
			return fmt.Errorf("failed to mark join request approved: %w", err)
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
				w.logger.Warn("failed to load org name for join-approved notification",
					"org_id", orgID,
					"pubkey", pubkey,
					"tx_hash", txHash,
					"err", err)
			}
		} else if orgName != "" {
			orgLabel = orgName
		}

		if err := notifications.EmitUserNotification(ctx, w.db, w.notifHub, w.dispatcher,
			pubkey, "join_approved", "Join Request Approved",
			fmt.Sprintf("You've been accepted into %s.", orgLabel),
			requestID, orgID); err != nil {
			w.logger.Warn("failed to emit join_approved notification", "org_id", orgID, "pubkey", pubkey, "err", err)
		}

		return nil
	}

	if _, err := w.db.Exec(ctx, `
		INSERT INTO members (
			org_id,
			pubkey,
			x25519_pubkey,
			pre_pubkey,
			role,
			can_contribute,
			can_moderate,
			join_epoch,
			member_tier,
			is_trial,
			trial_expires_at,
			chain_confirmed,
			active
		)
		VALUES (
			$1,
			$2,
			$3,
			NULL,
			$4,
			$5,
			$6,
			$7,
			'member',
			FALSE,
			NULL,
			TRUE,
			TRUE
		)
		ON CONFLICT (org_id, pubkey) DO UPDATE
		SET role = EXCLUDED.role,
		    can_contribute = EXCLUDED.can_contribute,
		    can_moderate = EXCLUDED.can_moderate,
		    chain_confirmed = TRUE,
		    active = TRUE,
		    updated_at = NOW()
	`, orgID, pubkey, x25519Pubkey, role, canContribute, canModerate, currentEpoch); err != nil {
		return fmt.Errorf("failed to upsert confirmed invited member: %w", err)
	}

	w.logger.Info("confirmed invited member without join request; awaiting key registration",
		"org_id", orgID,
		"pubkey", pubkey,
		"tx_hash", txHash)

	return nil
}

func (w *ChainWatcher) processTransferLeadershipBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string, newLeader string, newLeaderWallet string) error {
	var currentLeaderPubkey string
	err := w.db.QueryRow(ctx, `
		SELECT leader_pubkey
		FROM orgs
		WHERE org_id = $1
	`, orgID).Scan(&currentLeaderPubkey)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			w.logger.Warn("org row not found when resolving current leader",
				"org_id", orgID,
				"tx_hash", txHash)
		} else {
			return fmt.Errorf("failed to load current org leader: %w", err)
		}
	}

	demoteTag, err := w.db.Exec(ctx, `
		UPDATE members
		SET role = 'member',
		    updated_at = NOW()
		WHERE org_id = $1 AND role = 'leader'
	`, orgID)
	if err != nil {
		return fmt.Errorf("failed to demote previous leader: %w", err)
	}
	if demoteTag.RowsAffected() == 0 {
		w.logger.Warn("no leader row demoted during transfer-leadership bookkeeping",
			"org_id", orgID,
			"current_leader_pubkey", currentLeaderPubkey,
			"new_leader", newLeader,
			"tx_hash", txHash)
	}

	promoteTag, err := w.db.Exec(ctx, `
		UPDATE members
		SET role = 'leader',
		    wallet_address = $1,
		    chain_confirmed = TRUE,
		    active = TRUE,
		    updated_at = NOW()
		WHERE org_id = $2 AND pubkey = $3
	`, newLeaderWallet, orgID, newLeader)
	if err != nil {
		return fmt.Errorf("failed to promote new leader: %w", err)
	}
	if promoteTag.RowsAffected() == 0 {
		w.logger.Warn("new leader row not found during transfer-leadership bookkeeping",
			"org_id", orgID,
			"new_leader", newLeader,
			"tx_hash", txHash)
	}

	orgTag, err := w.db.Exec(ctx, `
		UPDATE orgs
		SET leader_pubkey = $1
		WHERE org_id = $2
	`, newLeader, orgID)
	if err != nil {
		return fmt.Errorf("failed to update org leader pointer: %w", err)
	}
	if orgTag.RowsAffected() == 0 {
		w.logger.Warn("org row not found during transfer-leadership bookkeeping",
			"org_id", orgID,
			"new_leader", newLeader,
			"tx_hash", txHash)
	}

	return nil
}

func (w *ChainWatcher) processCloseOrgBookkeeping(ctx context.Context, txHash string, blockHeight int64, blockTime time.Time, orgID string) error {
	orgTag, err := w.db.Exec(ctx, `
		UPDATE orgs
		SET status = 'closed'
		WHERE org_id = $1
	`, orgID)
	if err != nil {
		return fmt.Errorf("failed to mark org closed: %w", err)
	}
	if orgTag.RowsAffected() == 0 {
		w.logger.Warn("org row not found during close-org bookkeeping",
			"org_id", orgID,
			"tx_hash", txHash)
	}

	memberTag, err := w.db.Exec(ctx, `
		UPDATE members
		SET active = false,
		    updated_at = NOW()
		WHERE org_id = $1
	`, orgID)
	if err != nil {
		return fmt.Errorf("failed to deactivate members for closed org: %w", err)
	}
	if memberTag.RowsAffected() == 0 {
		w.logger.Warn("no member rows updated during close-org bookkeeping",
			"org_id", orgID,
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
