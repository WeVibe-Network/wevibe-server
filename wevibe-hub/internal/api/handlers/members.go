package handlers

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/billing"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/envelopes"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

func InviteMember(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req protocol.InviteMemberRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	if req.Pubkey == "" || req.X25519Pubkey == "" || req.Role == "" {
		http.Error(w, `{"error":"missing required fields"}`, http.StatusBadRequest)
		return
	}

	if req.EncEnvelope == "" || req.SearchEnvelope == "" {
		http.Error(w, `{"error":"enc_envelope and search_envelope are required"}`, http.StatusBadRequest)
		return
	}

	if req.PrePubkey != "" {
		_, err = decodePrePubkey(req.PrePubkey)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "pre_pubkey must be valid hex and exactly 33 bytes")
			return
		}
	}

	if req.CanModerate || req.Role == "leader" {
		if req.ModEnvelope == "" {
			http.Error(w, `{"error":"mod_envelope is required for moderator/leader role"}`, http.StatusBadRequest)
			return
		}
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
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden")
		return
	}

	canonical := verify.InviteMemberMessage(orgID, req.Pubkey, req.X25519Pubkey, req.Role, req.SignedBy, req.EncEnvelope, req.SearchEnvelope, req.ModEnvelope, req.CanContribute, req.CanModerate)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	currentEpoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	member, err := members.InviteMember(r.Context(), pool, orgID, currentEpoch, req)
	if err != nil {
		if errors.Is(err, members.ErrInvalidPrePubkey) {
			WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "pre_pubkey must be valid hex and exactly 33 bytes")
			return
		}
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			http.Error(w, `{"error":"member already exists"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	var modEnv *string
	if req.ModEnvelope != "" {
		modEnv = &req.ModEnvelope
	}

	if err := envelopes.Store(r.Context(), pool, orgID, req.Pubkey, currentEpoch, req.EncEnvelope, req.SearchEnvelope, modEnv); err != nil {
		http.Error(w, `{"error":"failed to store member envelope"}`, http.StatusInternalServerError)
		return
	}

	// Admission does not consume hub credits. Recall stays gated by
	// membership_active until an explicit enable-recall subscription action.

	if updated, err := members.GetMember(r.Context(), pool, orgID, req.Pubkey); err == nil {
		member = updated
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(member)
}

func GetMember(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	member, err := members.GetMember(r.Context(), pool, orgID, pubkey)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"member not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(member)
}
func GetKeyEnvelope(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized: valid Authorization header required")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	pubkey := signed.Pubkey

	env, err := envelopes.Get(r.Context(), pool, orgID, pubkey)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"envelope not found for this member"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(protocol.KeyEnvelopeResponse{
		OrgID:          orgID,
		EpochID:        env.EpochID,
		EncEnvelope:    env.EncEnvelope,
		SearchEnvelope: env.SearchEnvelope,
		ModEnvelope:    env.ModEnvelope,
	})
}

func ListMembers(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	membersList, err := members.ListMembers(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	wallets := make([]string, 0, len(membersList))
	for _, member := range membersList {
		if member.WalletAddress != nil && strings.TrimSpace(*member.WalletAddress) != "" {
			wallets = append(wallets, *member.WalletAddress)
		}
	}
	displayNames := resolveWalletDisplayNames(r.Context(), wallets)
	for idx := range membersList {
		if membersList[idx].WalletAddress == nil {
			continue
		}
		wallet := strings.TrimSpace(*membersList[idx].WalletAddress)
		if wallet == "" {
			continue
		}
		if displayName := displayNames[wallet]; displayName != "" {
			membersList[idx].DisplayName = &displayName
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(membersList)
}

func GetMemberOrgs(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	pubkey := chi.URLParam(r, "pubkey")
	if pubkey == "" {
		http.Error(w, `{"error":"pubkey required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized: valid Authorization header required")
		return
	}

	if signed.Pubkey != pubkey {
		http.Error(w, `{"error":"authorization pubkey does not match path pubkey"}`, http.StatusBadRequest)
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	entries, err := members.ListOrgsForMember(r.Context(), pool, pubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if entries == nil {
		entries = []protocol.MemberOrgEntry{}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(protocol.MemberOrgsResponse{Orgs: entries})
}

func LinkWallet(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req protocol.LinkWalletRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	if req.WalletAddress == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"wallet_address, signed_by, and signature are required"}`, http.StatusBadRequest)
		return
	}

	msg := fmt.Sprintf("link_wallet|%s|%s|%s", orgID, req.WalletAddress, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, []byte(msg)); err != nil {
		http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
		return
	}

	member, err := members.GetMember(r.Context(), pool, orgID, req.SignedBy)
	if err != nil || !member.Active {
		http.Error(w, `{"error":"not an active member of this org"}`, http.StatusForbidden)
		return
	}

	if err := members.LinkWallet(r.Context(), pool, orgID, req.SignedBy, req.WalletAddress); err != nil {
		http.Error(w, err.Error(), http.StatusConflict)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"status":         "linked",
		"wallet_address": req.WalletAddress,
		"pubkey":         req.SignedBy,
	})
}

type disableMemberRecallRequest struct {
	SignedBy string `json:"signed_by"`
}

type storeMemberKFragRequest struct {
	EpochID   uint64 `json:"epoch_id"`
	PrePubkey string `json:"pre_pubkey"`
	Kfrag     string `json:"kfrag"`
}

func EnableMemberRecall(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	memberPubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || memberPubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden")
		return
	}

	var req protocol.EnableMemberRecallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	if req.PrePubkey != "" {
		prePubkeyBytes, err := decodePrePubkey(req.PrePubkey)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "pre_pubkey must be valid hex and exactly 33 bytes")
			return
		}

		if err := members.SetPrePubkey(r.Context(), pool, orgID, memberPubkey, prePubkeyBytes); err == pgx.ErrNoRows {
			http.Error(w, `{"error":"member not found"}`, http.StatusNotFound)
			return
		} else if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
	}

	if req.Free {
		err = billing.GrantFreeRecall(r.Context(), pool, orgID, memberPubkey, signed.Pubkey)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]bool{"membership_active": true})
		return
	}

	err = billing.Subscribe(r.Context(), pool, orgID, memberPubkey, signed.Pubkey)
	if err != nil {
		if errors.Is(err, billing.ErrInsufficientCredits) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPaymentRequired)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "insufficient org credits to enable recall"})
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"membership_active": true})
}

func DisableMemberRecall(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	memberPubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || memberPubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden")
		return
	}

	var req disableMemberRecallRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	err = billing.RevokeRecall(r.Context(), pool, orgID, memberPubkey, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]bool{"membership_active": false})
}

func StoreMemberKFrag(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	defer func() {
		wlog.Op(ctx, "hub.store_kfrag", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	memberPubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || memberPubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized: valid Authorization header required")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req storeMemberKFragRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	prePubkey, err := decodePrePubkey(req.PrePubkey)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "pre_pubkey must be valid hex and exactly 33 bytes")
		return
	}

	wlog.Op(ctx, "hub.store_kfrag", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID),
		slog.String("member", memberPubkey),
		slog.String("member_pk_fp", wlog.Fingerprint(prePubkey)),
		slog.Uint64("epoch", req.EpochID))

	kfrag, err := hex.DecodeString(req.Kfrag)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_kfrag", "kfrag must be valid hex")
		return
	}

	if umbralService == nil {
		WriteError(w, 500, "umbral_unavailable", "recall key service unavailable")
		return
	}

	if err := umbralService.StoreKFrag(r.Context(), orgID, req.EpochID, prePubkey, kfrag); err != nil {
		wlog.Op(ctx, "hub.store_kfrag", slog.LevelError,
			slog.String("phase", "store-err"),
			slog.String("org", orgID),
			slog.String("member_pk_fp", wlog.Fingerprint(prePubkey)),
			slog.Uint64("epoch", req.EpochID),
			slog.String("err", err.Error()))
		log.Printf("[kfrag] StoreKFrag failed org=%s epoch=%d: %v", orgID, req.EpochID, err)
		WriteError(w, http.StatusInternalServerError, "kfrag_store_failed", "failed to store recall key in sidecar", err.Error())
		return
	}

	status = "ok"
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func RegisterPreKey(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized: valid Authorization header required")
		return
	}

	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "timestamp_invalid", "invalid timestamp format, use RFC3339")
		return
	}

	now := time.Now()
	if now.Sub(ts) > 5*time.Minute || ts.Sub(now) > 5*time.Minute {
		WriteError(w, http.StatusUnauthorized, "timestamp_expired", "timestamp expired or too far in future")
		return
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		WriteError(w, http.StatusUnauthorized, "unauthorized", "unauthorized")
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_request", "bad request")
		return
	}

	var req protocol.RegisterPreKeyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_json", "invalid json")
		return
	}

	prePubkey, err := decodePrePubkey(req.PrePubkey)
	if err != nil {
		WriteError(w, http.StatusBadRequest, "invalid_pre_pubkey", "pre_pubkey must be valid hex and exactly 33 bytes")
		return
	}

	if signed.Pubkey != pubkey {
		isLeader, err := members.IsLeader(r.Context(), pool, orgID, signed.Pubkey)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		if !isLeader {
			WriteError(w, http.StatusForbidden, "forbidden_leader_only", "forbidden")
			return
		}
	}

	if err := members.SetPrePubkey(r.Context(), pool, orgID, pubkey, prePubkey); err == pgx.ErrNoRows {
		http.Error(w, `{"error":"member not found"}`, http.StatusNotFound)
		return
	} else if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func GetPreKey(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		WriteError(w, http.StatusServiceUnavailable, "db_unavailable", "database unavailable")
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		WriteError(w, http.StatusBadRequest, "invalid_request", "org_id and pubkey required")
		return
	}

	prePubkey, err := members.GetPrePubkey(r.Context(), pool, orgID, pubkey)
	if err == pgx.ErrNoRows {
		http.Error(w, `{"error":"pre_pubkey not found"}`, http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(protocol.MemberPreKeyResponse{PrePubkey: hex.EncodeToString(prePubkey)})
}

func decodePrePubkey(prePubkey string) ([]byte, error) {
	decoded, err := hex.DecodeString(prePubkey)
	if err != nil {
		return nil, err
	}
	if len(decoded) != 33 {
		return nil, fmt.Errorf("invalid pre_pubkey length")
	}
	return decoded, nil
}
