package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/orgs"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

func StoreRecoveryShares(w http.ResponseWriter, r *http.Request) {
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

	var req protocol.StoreRecoverySharesRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.SignedBy == "" || req.Signature == "" || len(req.Shares) == 0 {
		http.Error(w, `{"error":"signed_by, signature, and shares required"}`, http.StatusBadRequest)
		return
	}

	if len(req.Shares) > 3 {
		http.Error(w, `{"error":"maximum 3 shares allowed"}`, http.StatusBadRequest)
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
		http.Error(w, `{"error":"forbidden: only leader can store recovery shares"}`, http.StatusForbidden)
		return
	}

	canonical := storeRecoverySharesMessage(orgID, req.SignedBy, len(req.Shares))
	if err := verify.RequestSignature(req.SignedBy, req.Signature, canonical); err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	for _, share := range req.Shares {
		if share.ShareIndex < 1 || share.ShareIndex > 3 {
			http.Error(w, `{"error":"share_index must be 1, 2, or 3"}`, http.StatusBadRequest)
			return
		}
		if share.SealedShare == "" || share.HolderPubkey == "" {
			http.Error(w, `{"error":"sealed_share and holder_pubkey required per share"}`, http.StatusBadRequest)
			return
		}

		_, err := pool.Exec(r.Context(), `
			INSERT INTO recovery_shares (org_id, share_index, holder_pubkey, sealed_share)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (org_id, share_index) DO UPDATE SET
				holder_pubkey = EXCLUDED.holder_pubkey,
				sealed_share = EXCLUDED.sealed_share,
				created_at = NOW()
		`, orgID, share.ShareIndex, share.HolderPubkey, share.SealedShare)
		if err != nil {
			http.Error(w, `{"error":"failed to store share"}`, http.StatusInternalServerError)
			return
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(map[string]string{"status": "stored"})
}

func GetRecoveryShare(w http.ResponseWriter, r *http.Request) {
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
		http.Error(w, `{"error":"invalid timestamp format"}`, http.StatusBadRequest)
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

	rows, err := pool.Query(r.Context(), `
		SELECT org_id, share_index, sealed_share
		FROM recovery_shares
		WHERE org_id = $1 AND holder_pubkey = $2
	`, orgID, signed.Pubkey)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var shares []protocol.RecoveryShareResponse
	for rows.Next() {
		var s protocol.RecoveryShareResponse
		if err := rows.Scan(&s.OrgID, &s.ShareIndex, &s.SealedShare); err != nil {
			http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
			return
		}
		shares = append(shares, s)
	}

	if len(shares) == 0 {
		http.Error(w, `{"error":"no recovery shares found for this holder"}`, http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(shares)
}

func storeRecoverySharesMessage(orgID, signedBy string, shareCount int) []byte {
	return []byte(fmt.Sprintf("wevibe.store_recovery_shares.v1\norg_id:%s\nshare_count:%d\nsigned_by:%s", orgID, shareCount, signedBy))
}
