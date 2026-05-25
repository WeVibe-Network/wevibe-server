package handlers

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/envelopes"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func InviteMember(w http.ResponseWriter, r *http.Request) {
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

	var req protocol.InviteMemberRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
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

	var prePubkeyBytes []byte
	if req.PrePubkey != "" {
		prePubkeyBytes, err = decodePrePubkey(req.PrePubkey)
		if err != nil {
			http.Error(w, `{"error":"pre_pubkey must be valid hex and exactly 33 bytes"}`, http.StatusBadRequest)
			return
		}
	}

	if req.Role == "moderator" || req.Role == "leader" {
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
		http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
		return
	}

	canonical := verify.InviteMemberMessage(orgID, req.Pubkey, req.X25519Pubkey, req.Role, req.SignedBy, req.EncEnvelope, req.SearchEnvelope, req.ModEnvelope)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
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
			http.Error(w, `{"error":"pre_pubkey must be valid hex and exactly 33 bytes"}`, http.StatusBadRequest)
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

	if umbralService != nil && req.EpochSK != "" && len(prePubkeyBytes) == 33 {
		epochSKBytes, err := hex.DecodeString(req.EpochSK)
		if err != nil {
			log.Printf("WARNING: failed to decode epoch_sk for kfrag generation: %v", err)
		} else {
			_, err := umbralService.RegisterMember(r.Context(), orgID, uint64(currentEpoch), epochSKBytes, prePubkeyBytes, epochSKBytes, epochSKBytes)
			if err != nil {
				log.Printf("ERROR: failed to generate kfrags for org=%s member=%s epoch=%d: %v", orgID, req.Pubkey, currentEpoch, err)
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(member)
}

func GetMember(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
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

func RemoveMember(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.RemoveMemberRequest
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

	canonical := verify.RemoveMemberMessage(orgID, pubkey, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	currentEpoch, err := orgs.GetCurrentEpoch(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := members.RemoveMember(r.Context(), pool, orgID, pubkey, currentEpoch); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	if err := envelopes.Delete(r.Context(), pool, orgID, pubkey); err != nil {
		log.Printf("WARNING: failed to delete envelope for %s in org %s: %v", pubkey, orgID, err)
	}

	memberPKBytes, err := hex.DecodeString(pubkey)
	if err != nil {
		log.Printf("WARNING: failed to decode member pubkey %s: %v", pubkey, err)
	} else if umbralService != nil {
		if _, err := umbralService.OnMemberRemoved(r.Context(), orgID, memberPKBytes); err != nil {
			log.Printf("ERROR: failed to delete kfrags from sidecar for org=%s member=%s: %v — manual cleanup required", orgID, pubkey, err)
		}
	}

	if err := orgs.SetRotationPending(r.Context(), pool, orgID); err != nil {
		http.Error(w, `{"error":"failed to set rotation pending"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

func GetKeyEnvelope(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
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
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	pubkey := chi.URLParam(r, "pubkey")
	if pubkey == "" {
		http.Error(w, `{"error":"pubkey required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
		return
	}

	if signed.Pubkey != pubkey {
		http.Error(w, `{"error":"authorization pubkey does not match path pubkey"}`, http.StatusBadRequest)
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

	var req protocol.LinkWalletRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
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

func UpdateMemberRole(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.UpdateMemberRoleRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.Role == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"role, signed_by, and signature required"}`, http.StatusBadRequest)
		return
	}

	if req.Role == "leader" {
		http.Error(w, `{"error":"cannot set role to 'leader' via this endpoint (use transfer-leadership)"}`, http.StatusBadRequest)
		return
	}

	if req.Role != "moderator" && req.Role != "member" {
		http.Error(w, `{"error":"role must be 'moderator' or 'member'"}`, http.StatusBadRequest)
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

	if req.SignedBy == pubkey {
		http.Error(w, `{"error":"leader cannot change own role"}`, http.StatusBadRequest)
		return
	}

	canonical := verify.UpdateMemberRoleMessage(orgID, pubkey, req.Role, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	member, err := members.GetMember(r.Context(), pool, orgID, pubkey)
	if err != nil || !member.Active {
		http.Error(w, `{"error":"member not found or inactive"}`, http.StatusNotFound)
		return
	}

	if req.Role == "moderator" {
		if member.WalletAddress == nil || strings.TrimSpace(*member.WalletAddress) == "" {
			http.Error(w, `{"error":"display name registration required before accepting moderator role"}`, http.StatusBadRequest)
			return
		}
		if socialClient == nil {
			http.Error(w, `{"error":"social graph unavailable"}`, http.StatusServiceUnavailable)
			return
		}
		profile, profileErr := socialClient.GetProfile(r.Context(), strings.TrimSpace(*member.WalletAddress))
		if profileErr != nil || profile == nil || strings.TrimSpace(profile.DisplayName) == "" {
			http.Error(w, `{"error":"display name registration required before accepting moderator role"}`, http.StatusBadRequest)
			return
		}
	}

	if err := members.UpdateMemberRole(r.Context(), pool, orgID, pubkey, req.Role); err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	updated, _ := members.GetMember(r.Context(), pool, orgID, pubkey)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(updated)
}

func RegisterDelegateKey(w http.ResponseWriter, r *http.Request) {
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

	var req protocol.RegisterDelegateKeyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.WalletAddress == "" || req.DelegateAddress == "" || req.DelegatePubkey == "" || req.SignedBy == "" || req.Signature == "" {
		http.Error(w, `{"error":"wallet_address, delegate_address, delegate_pubkey, signed_by, and signature are required"}`, http.StatusBadRequest)
		return
	}

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized: valid Authorization header required"}`, http.StatusUnauthorized)
		return
	}

	if signed.Pubkey != req.SignedBy {
		http.Error(w, `{"error":"signed_by does not match Authorization header"}`, http.StatusForbidden)
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

	canonical := fmt.Sprintf("register_delegate|%s|%s|%s|%s", orgID, req.WalletAddress, req.DelegateAddress, req.SignedBy)
	if err := verify.RequestSignature(req.SignedBy, req.Signature, []byte(canonical)); err != nil {
		http.Error(w, `{"error":"invalid signature"}`, http.StatusUnauthorized)
		return
	}

	member, err := members.GetMember(r.Context(), pool, orgID, req.SignedBy)
	if err != nil || !member.Active {
		http.Error(w, `{"error":"not an active member of this org"}`, http.StatusForbidden)
		return
	}

	if member.WalletAddress == nil || *member.WalletAddress != req.WalletAddress {
		http.Error(w, `{"error":"caller does not own this wallet_address"}`, http.StatusForbidden)
		return
	}

	if err := members.RegisterDelegateKey(r.Context(), pool, &req); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			http.Error(w, `{"error":"delegate address already registered"}`, http.StatusConflict)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "registered"})
}

func RegisterPreKey(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req protocol.RegisterPreKeyRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	prePubkey, err := decodePrePubkey(req.PrePubkey)
	if err != nil {
		http.Error(w, `{"error":"pre_pubkey must be valid hex and exactly 33 bytes"}`, http.StatusBadRequest)
		return
	}

	if signed.Pubkey != pubkey {
		isLeader, err := members.IsLeader(r.Context(), pool, orgID, signed.Pubkey)
		if err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		if !isLeader {
			http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
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
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	pubkey := chi.URLParam(r, "pubkey")
	if orgID == "" || pubkey == "" {
		http.Error(w, `{"error":"org_id and pubkey required"}`, http.StatusBadRequest)
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
