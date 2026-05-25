package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
)

// Category B chain config (serve_attestation_required, min_contributions_per_epoch,
// contest_stake_vibe, rep_tiers) is no longer written via the hub. Per Decision C
// (CO-011a.4) the dashboard builds MsgSetOrgConfig / MsgSetRepTiers and broadcasts
// via the relay endpoint. The hub keeps the READ-ONLY GetOrgChainConfig handler so
// callers can fetch the current chain state without going through the chain RPC
// directly; there is no hub-side off-chain mirror for these fields.

func GetOrgChainConfig(w http.ResponseWriter, r *http.Request) {
	if chainClient == nil {
		http.Error(w, `{"error":"chain client unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	orgConfig, err := chainClient.GetOrgConfigFromChain(r.Context(), orgID)
	if err != nil {
		http.Error(w, `{"error":"failed to fetch chain org config"}`, http.StatusBadGateway)
		return
	}
	if orgConfig == nil {
		http.Error(w, `{"error":"org config not found on chain"}`, http.StatusNotFound)
		return
	}

	tiers, err := chainClient.GetRepTiersFromChain(r.Context(), orgID)
	if err != nil {
		http.Error(w, `{"error":"failed to fetch rep tiers"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"org_id":                      orgID,
		"serve_attestation_required":  orgConfig.ServeAttestationRequired,
		"min_contributions_per_epoch": orgConfig.MinContributionsPerEpoch,
		"contest_stake_vibe":          orgConfig.ContestStakeVibe,
		"rep_tiers":                   tiers,
	})
}