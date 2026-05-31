package handlers

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	sdk "github.com/cosmos/cosmos-sdk/types"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/chain"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/envelopes"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func CreateOrg(w http.ResponseWriter, r *http.Request) {
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

	if req.OrgID == "" || req.LeaderPubkey == "" || req.OrgName == "" || req.Domain == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}
	req.LeaderWallet = strings.TrimSpace(req.LeaderWallet)
	if req.LeaderWallet == "" {
		http.Error(w, `{"error":"leader_wallet is required"}`, http.StatusBadRequest)
		return
	}
	decodedWallet, err := sdk.GetFromBech32(req.LeaderWallet, "wevibe")
	if err != nil || sdk.VerifyAddressFormat(decodedWallet) != nil {
		http.Error(w, `{"error":"leader_wallet must be a valid bech32 address"}`, http.StatusBadRequest)
		return
	}

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

	canonical := verify.CreateOrgMessage(req.OrgID, req.LeaderPubkey, req.LeaderX25519Pubkey, req.OrgName, req.Domain, req.EncEnvelope, req.SearchEnvelope, req.ModEnvelope, req.PkMod, req.FeeModel)
	if err := verify.RequestSignature(req.LeaderPubkey, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var epochSK string
	var epochPK string
	if umbralService != nil {
		sk, pk, err := umbralService.GenerateEpochKeyPair(r.Context())
		if err != nil {
			log.Printf("WARNING: failed to generate epoch keypair: %v", err)
		} else {
			req.UmbralPK = pk
			epochSK = hex.EncodeToString(sk)
			epochPK = hex.EncodeToString(pk)
			log.Printf("generated epoch keypair for org=%s epoch=0", req.OrgID)
		}
	}

	org, err := orgs.CreateOrg(r.Context(), pool, req)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			http.Error(w, `{"error":"org already exists"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if chainClient == nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	faucetURL := os.Getenv("FAUCET_URL")

	hubServingKey, _, err := chainClient.EnsureOrgAccount(r.Context(), pool, org.OrgID)
	if err != nil {
		log.Printf("ERROR: failed to derive org serving key: org=%s err=%v", org.OrgID, err)
		http.Error(w, `{"error":"failed to derive org serving key"}`, http.StatusInternalServerError)
		return
	}
	if err := chainClient.FundAddressFromFaucet(r.Context(), faucetURL, hubServingKey, chain.TOPUP_AMOUNT); err != nil {
		log.Printf("ERROR: failed to fund org serving key: org=%s address=%s err=%v", org.OrgID, hubServingKey, err)
		http.Error(w, `{"error":"failed to fund org serving key"}`, http.StatusInternalServerError)
		return
	}

	modEnv := req.ModEnvelope
	if err := envelopes.Store(r.Context(), pool, req.OrgID, req.LeaderPubkey, 0, req.EncEnvelope, req.SearchEnvelope, &modEnv); err != nil {
		http.Error(w, `{"error":"failed to store leader envelope"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	resp := struct {
		*protocol.OrgInfo
		HubServingKeyAddress string `json:"hub_serving_key_address"`
		EpochSK              string `json:"epoch_sk,omitempty"`
		EpochPK              string `json:"epoch_pk,omitempty"`
	}{
		OrgInfo:              org,
		HubServingKeyAddress: hubServingKey,
		EpochSK:              epochSK,
		EpochPK:              epochPK,
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

func RotateEpoch(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.RotateEpochRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.NewPkMod == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}

	if len(req.Envelopes) == 0 {
		http.Error(w, `{"error":"envelopes array is required for rotation"}`, http.StatusBadRequest)
		return
	}

	leaderPubkey, err := orgs.GetLeaderPubkey(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if leaderPubkey != req.SignedBy {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	canonical := verify.RotateEpochMessage(orgID, req.NewPkMod, req.SignedBy, req.Envelopes)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var epochSK string
	var epochPK string
	if umbralService != nil {
		sk, pk, err := umbralService.GenerateEpochKeyPair(r.Context())
		if err != nil {
			log.Printf("WARNING: failed to generate epoch keypair for rotation: %v", err)
		} else {
			req.UmbralPK = pk
			epochSK = hex.EncodeToString(sk)
			epochPK = hex.EncodeToString(pk)
		}
	}

	if err := orgs.RotateEpoch(r.Context(), pool, orgID, req); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	newEpoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if epochPK != "" {
		log.Printf("generated epoch keypair for org=%s epoch=%d", orgID, newEpoch)
	}

	if chainClient != nil {
		log.Printf("epoch rotated: org=%s epoch=%d (chain will compute merkle root at next epoch tick)", orgID, newEpoch)
	}

	if err := envelopes.BatchReplace(r.Context(), pool, orgID, newEpoch, req.Envelopes); err != nil {
		http.Error(w, `{"error":"failed to store rotation envelopes"}`, http.StatusInternalServerError)
		return
	}

	bufferedCount, err := orgs.FinalizeRotationBuffer(r.Context(), pool, orgID, newEpoch)
	if err != nil {
		log.Printf("WARNING: failed to finalize rotation buffer for org %s: %v", orgID, err)
	}

	if err := orgs.ClearRotationPending(r.Context(), pool, orgID); err != nil {
		log.Printf("WARNING: failed to clear rotation_pending for org %s: %v", orgID, err)
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":         "ok",
		"buffered_moved": bufferedCount,
		"epoch_sk":       epochSK,
		"epoch_pk":       epochPK,
	})
}

func UpdateOrgConfig(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		http.Error(w, `{"error":"invalid timestamp"}`, http.StatusBadRequest)
		return
	}
	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		http.Error(w, `{"error":"timestamp expired"}`, http.StatusUnauthorized)
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req struct {
		RequiredApprovals   int    `json:"required_approvals"`
		ReportVoteThreshold int    `json:"report_vote_threshold"`
		WalletPubkey        []byte `json:"wallet_pubkey"`
		WalletSignature     []byte `json:"wallet_signature"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	securityFieldsChanged := false
	if req.RequiredApprovals > 0 || req.ReportVoteThreshold > 0 {
		securityFieldsChanged = true
	}

	if securityFieldsChanged {
		leaderWallet, walletErr := getLeaderWallet(r.Context(), pool, orgID)
		if walletErr != nil || leaderWallet == "" {
			http.Error(w, `{"error":"no wallet address on file for leader"}`, http.StatusForbidden)
			return
		}

		if len(req.WalletPubkey) == 0 || len(req.WalletSignature) == 0 {
			http.Error(w, `{"error":"wallet signature required for security config changes"}`, http.StatusUnauthorized)
			return
		}

		updates := map[string]interface{}{}
		if req.RequiredApprovals > 0 {
			updates["required_approvals"] = req.RequiredApprovals
		}
		if req.ReportVoteThreshold > 0 {
			updates["report_vote_threshold"] = req.ReportVoteThreshold
		}
		canonicalMsg := verify.BuildConfigUpdateCanonicalMessage(orgID, updates)
		if sigErr := verify.VerifyCosmosArbitrarySignature(leaderWallet, []byte(canonicalMsg), req.WalletPubkey, req.WalletSignature); sigErr != nil {
			http.Error(w, `{"error":"wallet signature verification failed"}`, http.StatusUnauthorized)
			return
		}
	}

	if req.RequiredApprovals < 1 {
		http.Error(w, `{"error":"required_approvals must be >= 1"}`, http.StatusBadRequest)
		return
	}

	if req.ReportVoteThreshold < 1 {
		http.Error(w, `{"error":"report_vote_threshold must be >= 1"}`, http.StatusBadRequest)
		return
	}

	if err := orgs.UpdateRequiredApprovals(r.Context(), pool, orgID, req.RequiredApprovals); err != nil {
		if strings.Contains(err.Error(), "org not found") {
			http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if req.ReportVoteThreshold > 0 {
		if err := orgs.UpdateReportVoteThreshold(r.Context(), pool, orgID, req.ReportVoteThreshold); err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{
		"required_approvals":    req.RequiredApprovals,
		"report_vote_threshold": req.ReportVoteThreshold,
	})
}

func getLeaderWallet(ctx context.Context, pool *pgxpool.Pool, orgID string) (string, error) {
	var wallet *string
	err := pool.QueryRow(ctx, `
		SELECT m.wallet_address FROM members m
		JOIN orgs o ON o.org_id = m.org_id AND o.leader_pubkey = m.pubkey
		WHERE m.org_id = $1 AND m.active = true
	`, orgID).Scan(&wallet)
	if err != nil {
		return "", err
	}
	if wallet != nil {
		return *wallet, nil
	}
	return "", nil
}

func TransferLeadership(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.TransferLeadershipRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.NewLeaderPubkey == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"new_leader_pubkey, signed_by, and signature required"}`, http.StatusBadRequest)
		return
	}

	leaderPubkey, err := orgs.GetLeaderPubkey(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if leaderPubkey != req.SignedBy {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	if req.NewLeaderPubkey == req.SignedBy {
		http.Error(w, `{"error":"cannot transfer leadership to self"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.TransferLeadershipMessage(orgID, req.NewLeaderPubkey, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := orgs.TransferLeadership(r.Context(), pool, orgID, req.SignedBy, req.NewLeaderPubkey); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func CloseOrg(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.CloseOrgRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"signed_by and signature required"}`, http.StatusBadRequest)
		return
	}

	leaderPubkey, err := orgs.GetLeaderPubkey(r.Context(), pool, orgID)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if leaderPubkey != req.SignedBy {
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	canonical := verify.CloseOrgMessage(orgID, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := orgs.CloseOrg(r.Context(), pool, orgID); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "closed"})
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
