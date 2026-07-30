package handlers

import (
	"context"
	"crypto/ed25519"
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
	servetypes "github.com/wevibe-network/wevibe-chain/x/serve/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/serves"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

func RecordServeEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var count int
	defer func() {
		wlog.Op(ctx, "hub.record_serve", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Int("count", count),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}
	wlog.Op(ctx, "hub.record_serve", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID))

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

	var req serves.RecordServeRequest // session_id is decoded via RecordServeRequest JSON tags.
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
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "serve_key_pubkey") ||
			strings.Contains(errMsg, "serve_sig") || strings.Contains(errMsg, "nonce") ||
			strings.Contains(errMsg, "contributor_id") ||
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
	status = "ok"
	count = 1

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":           "recorded",
		"serve_key_pubkey": record.ServeKeyPubkey,
	})
}

func RecordEvent(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	fingerprint8 := ""
	serveRef8 := ""
	defer func() {
		wlog.Op(ctx, "hub.record_event", slog.LevelInfo,
			slog.String("status", status),
			slog.String("fingerprint", fingerprint8),
			slog.String("serve_ref", serveRef8),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

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
	role, err := members.GetMemberRole(ctx, pool, orgID, signed.Pubkey)
	if err != nil || role == "" {
		http.Error(w, `{"error":"forbidden: org member required"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	if hasContentFields(body) {
		http.Error(w, `{"error":"content fields are not allowed"}`, http.StatusBadRequest)
		return
	}

	var req serves.RecordOutcomeRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	req.OrgID = orgID
	fingerprint8 = first8(req.Fingerprint)
	serveRef8 = first8(req.ServeRef)
	wlog.Op(ctx, "hub.record_event", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID),
		slog.String("fingerprint", fingerprint8),
		slog.String("serve_ref", serveRef8))
	if req.EventType != serves.EventTypeOutcome {
		http.Error(w, `{"error":"unsupported event_type"}`, http.StatusBadRequest)
		return
	}
	if err := validateServeRefIntake(req.ServeRef); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusBadRequest)
		return
	}

	canonical, signerPubkey, signature, verifyErr := canonicalOutcomeRequestBody(req)
	if verifyErr != nil {
		http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, verifyErr.Error()), http.StatusBadRequest)
		return
	}
	computed := hex.EncodeToString(servetypes.ComputeEventFingerprint(canonical))
	if computed != req.Fingerprint {
		http.Error(w, `{"error":"fingerprint mismatch"}`, http.StatusBadRequest)
		return
	}
	if !ed25519.Verify(ed25519.PublicKey(signerPubkey), canonical, signature) {
		http.Error(w, `{"error":"event signature verification failed"}`, http.StatusUnauthorized)
		return
	}

	inserted, err := serves.RecordOutcome(ctx, pool, req, signed.Pubkey)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"validation: %s"}`, err.Error()), http.StatusBadRequest)
		return
	}
	enqueueServeRelay(orgID)
	status = "ok"
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"status":  "recorded",
		"deduped": !inserted,
	})
}

func hasContentFields(body []byte) bool {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return false
	}
	for _, field := range []string{"text", "content", "plaintext", "score", "scores", "verdict", "verdicts"} {
		if _, ok := raw[field]; ok {
			return true
		}
	}
	return false
}

func validateServeRefIntake(value string) error {
	if value == "" {
		return fmt.Errorf("serve_ref is required")
	}
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return fmt.Errorf("serve_ref must be valid hex")
	}
	if len(decoded) != 32 {
		return fmt.Errorf("serve_ref must be exactly 32 bytes")
	}
	return nil
}

func canonicalOutcomeRequestBody(req serves.RecordOutcomeRequest) ([]byte, []byte, []byte, error) {
	memoryHash, err := decodeExactHex("memory_hash", req.MemoryContentHash, 32)
	if err != nil {
		return nil, nil, nil, err
	}
	signerPubkey, err := decodeExactHex("signer_pubkey", req.SignerPubkey, ed25519.PublicKeySize)
	if err != nil {
		return nil, nil, nil, err
	}
	nonce, err := hex.DecodeString(req.Nonce)
	if err != nil || len(nonce) == 0 {
		return nil, nil, nil, fmt.Errorf("nonce must be non-empty hex")
	}
	signature, err := decodeExactHex("signature", req.Signature, ed25519.SignatureSize)
	if err != nil {
		return nil, nil, nil, err
	}
	episodeRef, err := hex.DecodeString(req.EpisodeRef)
	if err != nil || len(episodeRef) == 0 {
		return nil, nil, nil, fmt.Errorf("episode_ref must be non-empty hex")
	}
	evidenceRef, err := hex.DecodeString(req.EvidenceRef)
	if err != nil || len(evidenceRef) == 0 {
		return nil, nil, nil, fmt.Errorf("evidence_ref must be non-empty hex")
	}
	serveRef, err := decodeExactHex("serve_ref", req.ServeRef, 32)
	if err != nil {
		return nil, nil, nil, err
	}
	entry := &servetypes.EventEntry{Body: &servetypes.EventEntry_Outcome{Outcome: &servetypes.OutcomeEventBody{
		EpisodeRef:  episodeRef,
		ServeRef:    serveRef,
		Worked:      req.Worked,
		EvidenceRef: evidenceRef,
	}}}
	body, err := servetypes.CanonicalEventBody(servetypes.EventType_EVENT_TYPE_OUTCOME, req.OrgID, memoryHash, uint64(req.EpochID), signerPubkey, nonce, entry)
	if err != nil {
		return nil, nil, nil, err
	}
	return body, signerPubkey, signature, nil
}

func decodeExactHex(field, value string, want int) ([]byte, error) {
	decoded, err := hex.DecodeString(value)
	if err != nil {
		return nil, fmt.Errorf("%s must be valid hex", field)
	}
	if len(decoded) != want {
		return nil, fmt.Errorf("%s must be %d bytes", field, want)
	}
	return decoded, nil
}

func first8(value string) string {
	if len(value) <= 8 {
		return value
	}
	return value[:8]
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
	relayHoldHours       = 24
	relayHoldExempt      map[string]struct{}
)

// poolType is the concrete pgxpool.Pool type used throughout the handlers
// package. Declared as a named alias so relay helpers read clearly without
// re-importing pgxpool everywhere.
type poolType = *pgxpool.Pool

func SetRelayHoldConfig(hours int, exemptOrgs []string) {
	if hours < 0 {
		hours = 0
	}
	relayHoldHours = hours

	if exemptOrgs == nil {
		relayHoldExempt = nil
		return
	}

	exemptSet := make(map[string]struct{}, len(exemptOrgs))
	for _, orgID := range exemptOrgs {
		trimmed := strings.TrimSpace(orgID)
		if trimmed == "" {
			continue
		}
		exemptSet[trimmed] = struct{}{}
	}
	relayHoldExempt = exemptSet
}

func effectiveRelayHoldHours(orgID string) int {
	if _, exempt := relayHoldExempt[orgID]; exempt {
		return 0
	}
	return relayHoldHours
}

func exemptOrgsSlice() []string {
	if len(relayHoldExempt) == 0 {
		return []string{}
	}

	orgs := make([]string, 0, len(relayHoldExempt))
	for orgID := range relayHoldExempt {
		orgs = append(orgs, orgID)
	}
	sort.Strings(orgs)
	return orgs
}

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

func EnqueueEligibleRelays(ctx context.Context) {
	if pool == nil || chainClient == nil {
		return
	}

	orgs, err := serves.ListOrgsWithEligiblePending(ctx, pool, relayHoldHours, exemptOrgsSlice())
	if err != nil {
		slog.Error("relay eligibility scan failed", "err", err)
		return
	}

	for _, orgID := range orgs {
		slog.Info("relay hold elapsed; enqueueing org", "org_id", orgID)
		enqueueServeRelay(orgID)
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

		hasPending, pendingErr := hasPendingRelayEvents(context.Background(), pool, orgID, effectiveRelayHoldHours(orgID))
		if pendingErr != nil {
			slog.Error("serve relay pending check failed", "org_id", orgID, "err", pendingErr)
			continue
		}
		if hasPending {
			enqueueServeRelay(orgID)
		}
	}
}

func hasPendingRelayEvents(ctx context.Context, p poolType, orgID string, holdHours int) (bool, error) {
	hasServes, err := serves.HasPendingEvents(ctx, p, orgID, holdHours)
	if err != nil {
		return false, err
	}
	if hasServes {
		return true, nil
	}
	outcomes, err := serves.PendingOutcomeEvents(ctx, p, orgID, 1)
	if err != nil {
		return false, err
	}
	return len(outcomes) > 0, nil
}

type relayPendingDeps struct {
	getPendingServes     func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error)
	getPendingDenials    func(context.Context, poolType, string, int) ([]serves.ServeEventRecord, error)
	getPendingOutcomes   func(context.Context, poolType, string, int) ([]serves.OutcomeEventRecord, error)
	submitRelayBatch     func(context.Context, *chain.GrpcClient, poolType, string, string, []sdktypes.Msg) (string, error)
	markServesSubmitted  func(context.Context, poolType, []int64, string) error
	markDenialsSubmitted func(context.Context, poolType, []int64, string) error
	markOutcomes         func(context.Context, poolType, []int64, string, string) error
	logRelayTxSubmission func(orgID string, msgCount, epochCount int, txHash string)
}

type relayTxBatch struct {
	msgs       []sdktypes.Msg
	serveIDs   []int64
	denialIDs  []int64
	outcomeIDs []int64
	epochs     int
}

func relayPendingEventsByOrg(ctx context.Context, cc *chain.GrpcClient, p poolType, orgID string) error {
	deps := relayPendingDeps{
		getPendingServes: func(ctx context.Context, p poolType, orgID string, limit int) ([]serves.ServeEventRecord, error) {
			return serves.GetPendingServes(ctx, p, orgID, limit, effectiveRelayHoldHours(orgID))
		},
		getPendingDenials: func(ctx context.Context, p poolType, orgID string, limit int) ([]serves.ServeEventRecord, error) {
			return serves.GetPendingDenials(ctx, p, orgID, limit, effectiveRelayHoldHours(orgID))
		},
		getPendingOutcomes: func(ctx context.Context, p poolType, orgID string, limit int) ([]serves.OutcomeEventRecord, error) {
			return serves.PendingOutcomeEvents(ctx, p, orgID, limit)
		},
		submitRelayBatch: func(ctx context.Context, cc *chain.GrpcClient, db poolType, faucetURL, orgID string, msgs []sdktypes.Msg) (string, error) {
			return cc.SubmitRelayBatch(ctx, db, faucetURL, orgID, msgs)
		},
		markServesSubmitted:  serves.MarkServesSubmitted,
		markDenialsSubmitted: serves.MarkDenialsSubmitted,
		markOutcomes:         serves.MarkOutcomeEvents,
		logRelayTxSubmission: func(orgID string, msgCount, epochCount int, txHash string) {
			slog.Info("relay submitted recall event tx",
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
	// receipt is committed on-chain before its denial: for any epoch E we
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
		outcomeRecords, err := deps.getPendingOutcomes(ctx, p, orgID, serveRelayFetchLimit)
		if err != nil {
			return fmt.Errorf("load pending outcomes: %w", err)
		}
		if len(serveRecords) == 0 && len(denialRecords) == 0 && len(outcomeRecords) == 0 {
			return nil
		}

		servesByEpoch := groupRecordsByEpoch(serveRecords)
		denialsByEpoch := groupRecordsByEpoch(denialRecords)
		outcomesByEpoch := groupOutcomeRecordsByEpoch(outcomeRecords)
		epochs := sortedUnionEpochs3(servesByEpoch, denialsByEpoch, outcomesByEpoch)

		batch := relayTxBatch{msgs: make([]sdktypes.Msg, 0, maxRelayMsgsPerTx)}
		for _, epochID := range epochs {
			epochMsgs, serveIDs, denialIDs, outcomeIDs, buildErr := buildRelayEpochMessages(cc, orgID, epochID, servesByEpoch[epochID], denialsByEpoch[epochID], outcomesByEpoch[epochID])
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
			batch.outcomeIDs = append(batch.outcomeIDs, outcomeIDs...)
			batch.epochs++
		}

		if len(batch.msgs) > 0 {
			if err := flushRelayTxBatch(ctx, cc, p, orgID, batch, deps); err != nil {
				return err
			}
		}
	}
}

func buildRelayEpochMessages(cc *chain.GrpcClient, orgID string, epochID int, serveRecords, denialRecords []serves.ServeEventRecord, outcomeRecords []serves.OutcomeEventRecord) ([]sdktypes.Msg, []int64, []int64, []int64, error) {
	if epochID < 0 {
		return nil, nil, nil, nil, fmt.Errorf("invalid epoch %d", epochID)
	}

	msgs := make([]sdktypes.Msg, 0, 3)
	serveIDs := make([]int64, 0, len(serveRecords))
	denialIDs := make([]int64, 0, len(denialRecords))
	outcomeIDs := make([]int64, 0, len(outcomeRecords))

	if len(serveRecords) > 0 {
		entries := make([]chain.ServeEntryInput, 0, len(serveRecords))
		for _, record := range serveRecords {
			entry, buildErr := serveEntryFromRecord(record)
			if buildErr != nil {
				return nil, nil, nil, nil, fmt.Errorf("build serve entry id=%d: %w", record.ID, buildErr)
			}
			entries = append(entries, entry)
			serveIDs = append(serveIDs, record.ID)
		}

		serveMsg, buildErr := cc.BuildServeBatchMsg(orgID, uint64(epochID), entries)
		if buildErr != nil {
			return nil, nil, nil, nil, fmt.Errorf("build serve batch epoch=%d size=%d: %w", epochID, len(entries), buildErr)
		}
		msgs = append(msgs, serveMsg)
	}

	if len(denialRecords) > 0 {
		entries := make([]chain.DenialEntryInput, 0, len(denialRecords))
		for _, record := range denialRecords {
			entry, buildErr := denialEntryFromRecord(record)
			if buildErr != nil {
				return nil, nil, nil, nil, fmt.Errorf("build denial entry id=%d: %w", record.ID, buildErr)
			}
			entries = append(entries, entry)
			denialIDs = append(denialIDs, record.ID)
		}

		denialMsg, buildErr := cc.BuildDenialBatchMsg(orgID, uint64(epochID), entries)
		if buildErr != nil {
			return nil, nil, nil, nil, fmt.Errorf("build denial batch epoch=%d size=%d: %w", epochID, len(entries), buildErr)
		}
		msgs = append(msgs, denialMsg)
	}

	if len(outcomeRecords) > 0 {
		entries := make([]chain.OutcomeEventInput, 0, len(outcomeRecords))
		for _, record := range outcomeRecords {
			entries = append(entries, chain.OutcomeEventInput{
				EpochID:           uint64(record.EpochID),
				MemoryContentHash: record.MemoryContentHash,
				SignerPubkey:      record.SignerPubkey,
				Nonce:             record.Nonce,
				Signature:         record.Signature,
				EpisodeRef:        record.EpisodeRef,
				ServeRef:          record.ServeRef,
				Worked:            record.Worked,
				EvidenceRef:       record.EvidenceRef,
				Fingerprint:       record.Fingerprint,
			})
			outcomeIDs = append(outcomeIDs, record.ID)
		}
		outcomeMsg, buildErr := cc.BuildEventBatchMsg(orgID, entries)
		if buildErr != nil {
			return nil, nil, nil, nil, fmt.Errorf("build outcome event batch epoch=%d size=%d: %w", epochID, len(entries), buildErr)
		}
		msgs = append(msgs, outcomeMsg)
	}

	return msgs, serveIDs, denialIDs, outcomeIDs, nil
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
	if markErr := deps.markOutcomes(ctx, db, batch.outcomeIDs, "submitted", txHash); markErr != nil {
		return fmt.Errorf("mark outcome batch submitted tx=%s: %w", txHash, markErr)
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

func groupOutcomeRecordsByEpoch(records []serves.OutcomeEventRecord) map[int]([]serves.OutcomeEventRecord) {
	byEpoch := make(map[int][]serves.OutcomeEventRecord)
	for _, record := range records {
		byEpoch[record.EpochID] = append(byEpoch[record.EpochID], record)
	}
	return byEpoch
}

// sortedUnionEpochs returns the ascending union of epoch keys across the two
// maps. Ascending order guarantees a denial is never relayed before the serve
// receipt it references (serveEpoch <= denialEpoch).
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

func sortedUnionEpochs3(a, b map[int][]serves.ServeEventRecord, c map[int][]serves.OutcomeEventRecord) []int {
	seen := make(map[int]struct{}, len(a)+len(b)+len(c))
	for e := range a {
		seen[e] = struct{}{}
	}
	for e := range b {
		seen[e] = struct{}{}
	}
	for e := range c {
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
	serveKeyPubkey, err := hex.DecodeString(record.ServeKeyPubkey)
	if err != nil || len(serveKeyPubkey) != 32 {
		return chain.ServeEntryInput{}, fmt.Errorf("invalid serve_key_pubkey %q", record.ServeKeyPubkey)
	}
	serveSig, err := hex.DecodeString(record.ServeSig)
	if err != nil || len(serveSig) != 64 {
		return chain.ServeEntryInput{}, fmt.Errorf("invalid serve_sig %q", record.ServeSig)
	}
	nonce, err := hex.DecodeString(record.Nonce)
	if err != nil || len(nonce) == 0 {
		return chain.ServeEntryInput{}, fmt.Errorf("invalid nonce %q", record.Nonce)
	}

	return chain.ServeEntryInput{
		MemoryContentHash: memHash,
		ServeKeyPubkey:    serveKeyPubkey,
		ServeSig:          serveSig,
		Nonce:             nonce,
		ContributorID:     record.ContributorID,
		ContributorWallet: strings.TrimSpace(record.ContributorWallet),
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
	serveKeyPubkey, err := hex.DecodeString(record.ServeKeyPubkey)
	if err != nil || len(serveKeyPubkey) != 32 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid serve_key_pubkey %q", record.ServeKeyPubkey)
	}
	serveSig, err := hex.DecodeString(record.ServeSig)
	if err != nil || len(serveSig) != 64 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid serve_sig %q", record.ServeSig)
	}
	serveFingerprint, err := hex.DecodeString(record.ServeFingerprint)
	if err != nil || len(serveFingerprint) != 32 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid serve_fingerprint %q", record.ServeFingerprint)
	}
	nonce, err := hex.DecodeString(record.Nonce)
	if err != nil || len(nonce) == 0 {
		return chain.DenialEntryInput{}, fmt.Errorf("invalid nonce %q", record.Nonce)
	}

	return chain.DenialEntryInput{
		MemoryHash:       memHash,
		Reason:           record.Reason,
		ServeKeyPubkey:   serveKeyPubkey,
		ServeSig:         serveSig,
		ServeFingerprint: serveFingerprint,
		Nonce:            nonce,
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
		EpochID          int    `json:"epoch_id"`
		MemoryHash       string `json:"memory_hash"`
		ServeKeyPubkey   string `json:"serve_key_pubkey"`
		ServeSig         string `json:"serve_sig"`
		Nonce            string `json:"nonce"`
		ServeFingerprint string `json:"serve_fingerprint"`
		Reason           string `json:"reason"`
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
		ServeKeyPubkey:    req.ServeKeyPubkey,
		ServeSig:          req.ServeSig,
		Nonce:             req.Nonce,
		ServeFingerprint:  req.ServeFingerprint,
		Reason:            req.Reason,
	}, signed.Pubkey)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "duplicate") {
			http.Error(w, fmt.Sprintf(`{"error":"%s"}`, errMsg), http.StatusConflict)
			return
		}
		if strings.Contains(errMsg, "memory_content_hash") || strings.Contains(errMsg, "serve_key_pubkey") ||
			strings.Contains(errMsg, "serve_sig") || strings.Contains(errMsg, "nonce") ||
			strings.Contains(errMsg, "serve_fingerprint") || strings.Contains(errMsg, "reason") {
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
		"status":            "recorded",
		"serve_fingerprint": record.ServeFingerprint,
	})
}
