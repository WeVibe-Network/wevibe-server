package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/cosmos/cosmos-sdk/types/bech32"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/envelopes"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

const (
	maxOrgDescriptionChars = 500
	maxOrgTechStackChars   = 200
	maxOrgFocusAreasChars  = 200
)

func containsASCIIControlByte(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 {
			return true
		}
	}
	return false
}

func CreateOrg(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var count int
	defer func() {
		wlog.Op(ctx, "hub.create_org", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Int("count", count),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.CreateOrgRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}
	wlog.Op(ctx, "hub.create_org", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", req.OrgID))

	if len(req.Description) > maxOrgDescriptionChars {
		http.Error(w, `{"error":"description too long (max 500 chars)"}`, http.StatusBadRequest)
		return
	}
	if len(req.TechStack) > maxOrgTechStackChars {
		http.Error(w, `{"error":"tech_stack too long (max 200 chars)"}`, http.StatusBadRequest)
		return
	}
	if len(req.FocusAreas) > maxOrgFocusAreasChars {
		http.Error(w, `{"error":"focus_areas too long (max 200 chars)"}`, http.StatusBadRequest)
		return
	}
	if containsASCIIControlByte(req.Description) {
		http.Error(w, `{"error":"description contains ASCII control bytes"}`, http.StatusBadRequest)
		return
	}
	if containsASCIIControlByte(req.TechStack) {
		http.Error(w, `{"error":"tech_stack contains ASCII control bytes"}`, http.StatusBadRequest)
		return
	}
	if containsASCIIControlByte(req.FocusAreas) {
		http.Error(w, `{"error":"focus_areas contains ASCII control bytes"}`, http.StatusBadRequest)
		return
	}

	if req.LeaderPubkey == "" || req.OrgName == "" || req.Domain == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}
	req.OrgID = strings.TrimSpace(req.OrgID)
	req.TxHash = strings.TrimSpace(req.TxHash)
	req.HubServingKey = strings.TrimSpace(req.HubServingKey)
	if req.OrgID == "" || req.TxHash == "" {
		http.Error(w, `{"error":"org_id and tx_hash are required"}`, http.StatusBadRequest)
		return
	}
	req.LeaderWallet = strings.TrimSpace(req.LeaderWallet)
	if req.LeaderWallet == "" {
		http.Error(w, `{"error":"leader_wallet is required"}`, http.StatusBadRequest)
		return
	}
	_, addrBytes, err := bech32.DecodeAndConvert(req.LeaderWallet)
	if err != nil {
		http.Error(w, `{"error":"invalid leader_wallet"}`, http.StatusBadRequest)
		return
	}
	leaderWalletAddr := sdk.AccAddress(addrBytes)
	if err := sdk.VerifyAddressFormat(leaderWalletAddr); err != nil {
		http.Error(w, `{"error":"invalid leader_wallet"}`, http.StatusBadRequest)
		return
	}
	orgID := req.OrgID

	if req.EncEnvelope == "" || req.SearchEnvelope == "" {
		http.Error(w, `{"error":"enc_envelope and search_envelope are required"}`, http.StatusBadRequest)
		return
	}

	if req.PkMod == "" {
		http.Error(w, `{"error":"pk_mod is required"}`, http.StatusBadRequest)
		return
	}

	if req.ModEnvelope == "" {
		http.Error(w, `{"error":"mod_envelope is required for org creation"}`, http.StatusBadRequest)
		return
	}

	if strings.TrimSpace(req.UmbralPK) == "" {
		http.Error(w, `{"error":"umbral_pk is required"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.CreateOrgMessage(req.LeaderPubkey, req.LeaderX25519Pubkey, req.OrgName, req.Domain, req.EncEnvelope, req.SearchEnvelope, req.ModEnvelope, req.PkMod, req.FeeModel)
	if err := verify.RequestSignature(req.LeaderPubkey, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	existingOrgID, err := orgs.GetOrgIDByLeader(r.Context(), pool, req.LeaderPubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	if existingOrgID != "" {
		http.Error(w, fmt.Sprintf(`{"error":"leader already owns an org","org_id":%q}`, existingOrgID), http.StatusConflict)
		return
	}

	org, err := orgs.CreateOrg(r.Context(), pool, orgID, req)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			http.Error(w, `{"error":"org already exists"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if _, err := pool.Exec(r.Context(), `
		UPDATE orgs
		SET chain_registered = true,
		    last_chain_submission_at = NOW(),
		    updated_at = NOW()
		WHERE org_id = $1
	`, org.OrgID); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	modEnv := req.ModEnvelope
	if err := envelopes.Store(r.Context(), pool, orgID, req.LeaderPubkey, req.EncEnvelope, req.SearchEnvelope, &modEnv); err != nil {
		http.Error(w, `{"error":"failed to store leader envelope"}`, http.StatusInternalServerError)
		return
	}
	status = "ok"
	count = 1

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	resp := struct {
		*protocol.OrgInfo
		HubServingKeyAddress string `json:"hub_serving_key_address"`
		LeaderWalletAddress  string `json:"leader_wallet_address"`
	}{
		OrgInfo:              org,
		HubServingKeyAddress: req.HubServingKey,
		LeaderWalletAddress:  req.LeaderWallet,
	}
	json.NewEncoder(w).Encode(resp)
}

func GetOrg(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	org, err := orgs.GetOrg(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	var memberCount int
	_ = pool.QueryRow(r.Context(), `SELECT COUNT(*) FROM members WHERE org_id=$1 AND active=true`, orgID).Scan(&memberCount)

	var lastActivity *time.Time
	_ = pool.QueryRow(r.Context(), `SELECT last_chain_submission_at FROM orgs WHERE org_id=$1`, orgID).Scan(&lastActivity)

	resp := struct {
		*protocol.OrgInfo
		MemberCount    int        `json:"member_count"`
		LastActivityAt *time.Time `json:"last_activity_at"`
	}{
		OrgInfo:        org,
		MemberCount:    memberCount,
		LastActivityAt: lastActivity,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func GetEpochManifest(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	epochIDStr := chi.URLParam(r, "epochID")
	epochID := -1
	if epochIDStr != "" && epochIDStr != "current" {
		var err error
		epochID, err = strconv.Atoi(epochIDStr)
		if err != nil {
			http.Error(w, `{"error":"invalid epoch_id"}`, http.StatusBadRequest)
			return
		}
	}

	manifest, err := orgs.GetEpochManifest(r.Context(), pool, orgID, epochID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"manifest not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(manifest)
}

func GetCurrentChainEpoch(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var epoch uint64
	defer func() {
		attrs := []slog.Attr{
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Uint64("epoch", epoch),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()),
		}
		wlog.Op(ctx, "hub.chain_epoch", slog.LevelInfo, attrs...)
	}()

	if chainClient == nil {
		http.Error(w, `{"error":"chain unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}
	wlog.Op(ctx, "hub.chain_epoch", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID))

	var err error
	epoch, err = chainClient.GetCurrentChainEpoch(ctx)
	if err != nil {
		wlog.Op(ctx, "hub.chain_epoch", slog.LevelError,
			slog.String("phase", "error"),
			slog.String("org", orgID),
			slog.String("error", err.Error()))
		http.Error(w, `{"error":"chain epoch unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if epoch == 0 {
		wlog.Op(ctx, "hub.chain_epoch", slog.LevelError,
			slog.String("phase", "error"),
			slog.String("org", orgID),
			slog.String("error", "chain epoch not initialized"))
		http.Error(w, `{"error":"chain epoch not initialized"}`, http.StatusServiceUnavailable)
		return
	}

	status = "ok"
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"epoch_id":         epoch,
		"epoch_identifier": "wevibe_epoch",
	})
}
