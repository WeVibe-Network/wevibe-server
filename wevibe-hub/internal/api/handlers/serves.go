package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	sdktypes "github.com/cosmos/cosmos-sdk/types"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func RecordServeEvent(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		http.Error(w, `{"error":"invalid timestamp format, use RFC3339"}`, http.StatusBadRequest)
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp expired or too far in future"}`, http.StatusUnauthorized)
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		http.Error(w, `{"error":"forbidden: org member required"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req serves.RecordServeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.OrgID = orgID

	record, err := serves.RecordServe(r.Context(), pool, req, signed.Pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "duplicate") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, errMsg), http.StatusConflict)
			return
		}
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "nullifier") ||
			strings.Contains(errMsg, "serve_key") || strings.Contains(errMsg, "contributor_id") ||
			strings.Contains(errMsg, "epoch_id") || strings.Contains(errMsg, "matched_keywords") {
			http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, errMsg), http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	// Chain relay is intentionally decoupled from the request path. A single
	// serve request should never block on block inclusion; instead we enqueue an
	// org-level relay pass that flushes pending serves/denials in batch TXs.
	enqueueServeRelay(orgID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}

const (
	serveRelayFetchLimit = 500
	serveRelayQueueSize  = 256
	serveRelayTimeout    = 3 * time.Minute
	serveRelayWorkers    = 8
	maxRelayMsgsPerTx    = 200
)

var (
	serveRelayWorkerOnce sync.Once
	serveRelayMu         sync.Mutex
	serveRelayQueued     map[string]struct{}
	serveRelayCh         chan string
)

// poolType is the concrete pgxpool.Pool type used throughout the handlers
// package. Declared as a named alias so relay helpers read clearly without
// re-importing pgxpool everywhere.
type poolType = *pgxpool.Pool

func ensureServeRelayWorker() {
	serveRelayWorkerOnce.Do(func() {
		serveRelayQueued = make(map[string]struct{})
		serveRelayCh = make(chan string, serveRelayQueueSize)
		for i := 0; i < serveRelayWorkers; i++ {
			go serveRelayWorker()
		}
	})
}

func enqueueServeRelay(orgID string) {
	if chainClient == nil {
		slog.Warn("chain client not configured; serve/denial relay skipped", "org_id", orgID)
		return
	}
	if pool == nil {
		return
	}

	orgID = strings.TrimSpace(orgID)
	if orgID == "" {
		return
	}

	ensureServeRelayWorker()

	serveRelayMu.Lock()
	if _, exists := serveRelayQueued[orgID]; exists {
		serveRelayMu.Unlock()
		return
	}
	serveRelayQueued[orgID] = struct{}{}
	serveRelayMu.Unlock()

	select {
	case serveRelayCh <- orgID:
	default:
		go func() {
			serveRelayCh <- orgID
		}()
	}
}

func serveRelayWorker() {
	for orgID := range serveRelayCh {
		if chainClient == nil || pool == nil {
			serveRelayMu.Lock()
			delete(serveRelayQueued, orgID)
			serveRelayMu.Unlock()
			continue
		}

		ctx, cancel := context.WithTimeout(context.Background(), serveRelayTimeout)
		err := relayPendingEventsByOrg(ctx, chainClient, pool, orgID)
		cancel()
		if err != nil {
			slog.Error("serve relay flush failed", "org_id", orgID, "err", err)
		}

		serveRelayMu.Lock()
		delete(serveRelayQueued, orgID)
		serveRelayMu.Unlock()

		hasPending, pendingErr := serves.HasPendingEvents(context.Background(), pool, orgID)
		if pendingErr != nil {
			slog.Error("serve relay pending check failed", "org_id", orgID, "err", pendingErr)
			continue
		}
		if hasPending {
			enqueueServeRelay(orgID)
		}
	}
}

type relayPendingDeps struct {
	getPendingServes     func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error)
	getPendingDenials    func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error)
	submitRelayBatch     func(context.Context, *chain.GrpcClient, poolType, string, string, []sdktypes.Msg) (string, error)
	markServesSubmitted  func(context.Context, poolType, []int64, string) error
	markDenialsSubmitted func(context.Context, poolType, []int64, string) error
	logRelayTxSubmission func(orgID string, msgCount, epochCount int, txHash string)
}

type relayTxBatch struct {
	msgs      []sdktypes.Msg
	serveIDs  []int64
	denialIDs []int64
	epochs    int
}

func relayPendingEventsByOrg(ctx context.Context, cc *chain.GrpcClient, p poolType, orgID string) error {
	deps := relayPendingDeps{
		getPendingServes:  serves.GetPendingServes,
		getPendingDenials: serves.GetPendingDenials,
		submitRelayBatch: func(ctx context.Context, cc *chain.GrpcClient, db poolType, faucetURL, orgID string, msgs []sdktypes.Msg) (string, error) {
			return cc.SubmitRelayBatch(ctx, db, faucetURL, orgID, msgs)
		},
		markServesSubmitted:  serves.MarkServesSubmitted,
		markDenialsSubmitted: serves.MarkDenialsSubmitted,
		logRelayTxSubmission: func(orgID string, msgCount, epochCount int, txHash string) {
			slog.Info("relay submitted serve/denial tx",
				"org_id", orgID,
				"entries", msgCount,
				"epochs", epochCount,
				"tx_hash", txHash,
			)
		},
	}

	return relayPendingEventsByOrgWithDeps(ctx, cc, p, orgID, deps)
}

func relayPendingEventsByOrgWithDeps(ctx context.Context, cc *chain.GrpcClient, p poolType, orgID string, deps relayPendingDeps) error {
	// Relay per epoch, serves-then-denials, oldest epoch first.
	//
	// Draining ALL pending serves before ANY pending denials (the previous
	// behaviour) starves denials under sustained serve volume: they land in a
	// burst tens of epochs after their originating serve — past the decay
	// settle window — so the per-epoch denial weight decrement is never applied
	// and bad memories never receive timely denial decay. Processing one epoch
	// at a time keeps each epoch's denials landing immediately after its serves
	// (within the settle lag) while preserving the invariant that a serve
	// attestation is committed on-chain before its denial: for any epoch E we
	// submit serves[E] before denials[E], and epochs are processed ascending so
	// a denial can never be submitted before the serve it references
	// (serveEpoch <= denialEpoch always).
	//
	// enqueueServeRelay/serveRelayQueued guarantees single-flight per org: only
	// one relay pass runs at a time for a given orgID, so this multi-message TX
	// path remains serialized for each org signer.
	for {
		serveRecords, err := deps.getPendingServes(ctx, p, orgID, serveRelayFetchLimit)
		if err != nil {
			return fmt.Errorf("load pending serves: %w", err)
		}
		denialRecords, err := deps.getPendingDenials(ctx, p, orgID, serveRelayFetchLimit)
		if err != nil {
			return fmt.Errorf("load pending denials: %w", err)
		}
		if len(serveRecords) == 0 && len(denialRecords) == 0 {
			return nil
		}

		servesByEpoch := groupRecordsByEpoch(serveRecords)
		denialsByEpoch := groupRecordsByEpoch(denialRecords)
		epochs := sortedUnionEpochs(servesByEpoch, denialsByEpoch)

		batch := relayTxBatch{msgs: make([]sdktypes.Msg, 0, maxRelayMsgsPerTx)}
		for _, epochID := range epochs {
			epochMsgs, serveIDs, denialIDs, buildErr := buildRelayEpochMessages(cc, orgID, epochID, servesByEpoch[epochID], denialsByEpoch[epochID])
			if buildErr != nil {
				return buildErr
			}
			if len(epochMsgs) == 0 {
				continue
			}

			if len(batch.msgs) > 0 && len(batch.msgs)+len(epochMsgs) > maxRelayMsgsPerTx {
				if err := flushRelayTxBatch(ctx, cc, p, orgID, batch, deps); err != nil {
					return err
				}
				batch = relayTxBatch{msgs: make([]sdktypes.Msg, 0, maxRelayMsgsPerTx)}
			}

			// Keep each epoch's serve+denial pair together in one transaction.
			batch.msgs = append(batch.msgs, epochMsgs...)
			batch.serveIDs = append(batch.serveIDs, serveIDs...)
			batch.denialIDs = append(batch.denialIDs, denialIDs...)
			batch.epochs++
		}

		if len(batch.msgs) > 0 {
			if err := flushRelayTxBatch(ctx, cc, p, orgID, batch, deps); err != nil {
				return err
			}
		}
	}
}

func buildRelayEpochMessages(cc *chain.GrpcClient, orgID string, epochID int, serveRecords, denialRecords []serves.ServeEventRecord) ([]sdktypes.Msg, []int64, []int64, error) {
	if epochID < 0 {
		return nil, nil, nil, fmt.Errorf("invalid epoch %d", epochID)
	}

	msgs := make([]sdktypes.Msg, 0, 2)
	serveIDs := make([]int64, 0, len(serveRecords))
	denialIDs := make([]int64, 0, len(denialRecords))

	if len(serveRecords) > 0 {
		entries := make([]chain.ServeEntryInput, 0, len(serveRecords))
		for _, record := range serveRecords {
			entry, buildErr := serveEntryFromRecord(record)
			if buildErr != nil {
				return nil, nil, nil, fmt.Errorf("build serve entry id=%d: %w", record.ID, buildErr)
			}
			entries = append(entries, entry)
			serveIDs = append(serveIDs, record.ID)
		}

		serveMsg, buildErr := cc.BuildServeBatchMsg(orgID, uint64(epochID), entries)
		if buildErr != nil {
			return nil, nil, nil, fmt.Errorf("build serve batch epoch=%d size=%d: %w", epochID, len(entries), buildErr)
		}
		msgs = append(msgs, serveMsg)
	}

	if len(denialRecords) > 0 {
		entries := make([]chain.DenialEntryInput, 0, len(denialRecords))
		for _, record := range denialRecords {
			entry, buildErr := denialEntryFromRecord(record)
			if buildErr != nil {
				return nil, nil, nil, fmt.Errorf("build denial entry id=%d: %w", record.ID, buildErr)
			}
			entries = append(entries, entry)
			denialIDs = append(denialIDs, record.ID)
		}

		denialMsg, buildErr := cc.BuildDenialBatchMsg(orgID, uint64(epochID), entries)
		if buildErr != nil {
			return nil, nil, nil, fmt.Errorf("build denial batch epoch=%d size=%d: %w", epochID, len(entries), buildErr)
		}
		msgs = append(msgs, denialMsg)
	}

	return msgs, serveIDs, denialIDs, nil
}

func flushRelayTxBatch(ctx context.Context, cc *chain.GrpcClient, db poolType, orgID string, batch relayTxBatch, deps relayPendingDeps) error {
	if len(batch.msgs) == 0 {
		return nil
	}

	txHash, submitErr := deps.submitRelayBatch(ctx, cc, db, os.Getenv("FAUCET_URL"), orgID, batch.msgs)
	if submitErr != nil {
		return fmt.Errorf("submit relay tx epochs=%d msgs=%d: %w", batch.epochs, len(batch.msgs), submitErr)
	}
	if markErr := deps.markServesSubmitted(ctx, db, batch.serveIDs, txHash); markErr != nil {
		return fmt.Errorf("mark serve batch submitted tx=%s: %w", txHash, markErr)
	}
	if markErr := deps.markDenialsSubmitted(ctx, db, batch.denialIDs, txHash); markErr != nil {
		return fmt.Errorf("mark denial batch submitted tx=%s: %w", txHash, markErr)
	}

	if deps.logRelayTxSubmission != nil {
		deps.logRelayTxSubmission(orgID, len(batch.msgs), batch.epochs, txHash)
	}

	return nil
}

// groupRecordsByEpoch buckets serve_event records by their epoch_id, preserving
// the input (created_at ASC) ordering within each bucket.
func groupRecordsByEpoch(records []serves.ServeEventRecord) map[int]([]serves.ServeEventRecord) {
	byEpoch := make(map[int][]serves.ServeEventRecord)
	for _, record := range records {
		byEpoch[record.EpochID] = append(byEpoch[record.EpochID], record)
	}
	return byEpoch
}

// sortedUnionEpochs returns the ascending union of epoch keys across the two
// maps. Ascending order guarantees a denial is never relayed before the serve
// attestation it references (serveEpoch <= denialEpoch).
func sortedUnionEpochs(a, b map[int][]serves.ServeEventRecord) []int {
	seen := make(map[int]struct{}, len(a)+len(b))
	for e := range a {
		seen[e] = struct{}{}
	}
	for e := range b {
		seen[e] = struct{}{}
	}
	epochs := make([]int, 0, len(seen))
	for e := range seen {
		epochs = append(epochs, e)
	}
	sort.Ints(epochs)
	return epochs
}

func serveEntryFromRecord(record serves.ServeEventRecord) (chain.ServeEntryInput, error) {
	memHash, err := hex.DecodeString(record.MemoryContentHash)
	if err != nil || len(memHash) != 32 {
		return chain.ServeEntryInput{}, fmt.Errorf("invalid memory_content_hash %q", record.MemoryContentHash)
	}
	nullifier, err := hex.DecodeString(record.Nullifier)
	if err != nil || len(nullifier) != 32 {
		return chain.ServeEntryInput{}, fmt.Errorf("invalid nullifier %q", record.Nullifier)
	}
	if len(record.MatchedKeywords) == 0 {
		return chain.ServeEntryInput{}, fmt.Errorf("matched_keywords cannot be empty")
	}

	return chain.ServeEntryInput{
		MemoryContentHash: memHash,
		ServeKey:          record.ServeKey,
		ContributorID:     record.ContributorID,
		ContributorWallet: strings.TrimSpace(record.ContributorWallet),
		Nullifier:         nullifier,
		ModelID:           record.ModelID,
		TurnCount:         uint32(record.TurnCount),
		MatchedKeywords:   record.MatchedKeywords,
	}, nil
}

func denialEntryFromRecord(record serves.ServeEventRecord) (chain.DenialEntryInput, error) {
	memHash, err := hex.DecodeString(record.MemoryContentHash)
	if err != nil || len(memHash) != 32 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid memory_content_hash %q", record.MemoryContentHash)
	}
	nullifier, err := hex.DecodeString(record.Nullifier)
	if err != nil || len(nullifier) != 32 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid nullifier %q", record.Nullifier)
	}
	denyKey := strings.TrimSpace(record.ServeKey)
	if denyKey == "" {
		denyKey = strings.TrimSpace(record.ReporterPubkey)
	}
	if denyKey == "" {
		return chain.DenialEntryInput{}, fmt.Errorf("deny key is empty")
	}

	return chain.DenialEntryInput{
		MemoryHash:      memHash,
		Nullifier:       nullifier,
		DenyKey:         denyKey,
		Reason:          record.Reason,
		MatchedKeywords: record.MatchedKeywords,
	}, nil
}

func RecordDenialEvent(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		http.Error(w, `{"error":"invalid timestamp format, use RFC3339"}`, http.StatusBadRequest)
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp expired or too far in future"}`, http.StatusUnauthorized)
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		http.Error(w, `{"error":"forbidden: org member required"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		EpochID    int    `json:"epoch_id"`
		MemoryHash string `json:"memory_hash"`
		Nullifier  string `json:"nullifier"`
		Reason     string `json:"reason"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	// Epoch is supplied by the caller (the live chain epoch), matching the serve
	// path. It must be the same epoch the originating serve was recorded under so
	// that the chain's per-epoch denial count, matched-keyword index, and
	// ApplyDenialDecay all align with the serve and run outside the grace window.
	epoch := req.EpochID
	if epoch < 0 {
		http.Error(w, `{"error":"epoch_id must be non-negative"}`, http.StatusBadRequest)
		return
	}

	record, err := serves.RecordDenial(r.Context(), pool, serves.RecordDenialRequest{
		OrgID:             orgID,
		EpochID:           epoch,
		MemoryContentHash: req.MemoryHash,
		Nullifier:         req.Nullifier,
		Reason:            req.Reason,
	}, signed.Pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "duplicate") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, errMsg), http.StatusConflict)
			return
		}
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "nullifier") || strings.Contains(errMsg, "reason") {
			http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, errMsg), http.StatusBadRequest)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	// Denials are flushed through the same async org-level relay queue as serves.
	enqueueServeRelay(orgID)

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "recorded",
		"nullifier": record.Nullifier,
	})
}
