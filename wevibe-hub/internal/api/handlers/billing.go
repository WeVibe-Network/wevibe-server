package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/billing"
	"github.com/go-chi/chi/v5"
)

func TopUpCredits(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	var req struct {
		OrgID  string `json:"org_id"`
		Amount int64  `json:"amount"`
		Actor  string `json:"signed_by"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.OrgID == "" || req.Amount <= 0 {
		http.Error(w, `{"error":"org_id and positive amount required"}`, http.StatusBadRequest)
		return
	}
	if err := billing.TopUp(r.Context(), pool, req.OrgID, req.Actor, req.Amount); err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	bal, _ := billing.GetBalance(r.Context(), pool, req.OrgID)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"org_id": req.OrgID, "balance": bal})
}

func GetOrgCredits(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"orgID required"}`, http.StatusBadRequest)
		return
	}
	bal, err := billing.GetBalance(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}
	limit := 20
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, e := strconv.Atoi(l); e == nil {
			limit = n
		}
	}
	txns, _ := billing.GetTransactions(r.Context(), pool, orgID, limit)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"org_id":       orgID,
		"balance":      bal,
		"transactions": txns,
	})
}

func GetOrgFinances(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"orgID required"}`, http.StatusBadRequest)
		return
	}

	bal, err := billing.GetBalance(r.Context(), pool, orgID)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusNotFound)
		return
	}

	var chainTreasury uint64
	if chainClient != nil {
		treasuryBalance, chainErr := chainClient.GetOrgTreasuryBalanceFromChain(r.Context(), orgID)
		if chainErr == nil {
			chainTreasury = treasuryBalance
		}
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"org_id":         orgID,
		"hub_credits":    bal,
		"chain_treasury": chainTreasury,
	})
}
