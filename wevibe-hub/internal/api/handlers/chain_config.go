package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-chain/x/org/types"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

type repTierPayload struct {
	MinReputation            uint64 `json:"min_reputation"`
	MaxReputation            uint64 `json:"max_reputation"`
	MaxContributionsPerEpoch uint64 `json:"max_contributions_per_epoch"`
	PayoutPerMemory          string `json:"payout_per_memory"`
}

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

func UpdateOrgChainConfig(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	if chainClient == nil {
		http.Error(w, `{"error":"chain client unavailable"}`, http.StatusServiceUnavailable)
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

	var req struct {
		ServeAttestationRequired bool             `json:"serve_attestation_required"`
		MinContributionsPerEpoch *uint64          `json:"min_contributions_per_epoch,omitempty"`
		ContestStakeVibe         *uint64          `json:"contest_stake_vibe,omitempty"`
		RepTiers                 []repTierPayload `json:"rep_tiers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if len(req.RepTiers) == 0 {
		http.Error(w, `{"error":"rep_tiers must not be empty"}`, http.StatusBadRequest)
		return
	}

	for _, tier := range req.RepTiers {
		if strings.TrimSpace(tier.PayoutPerMemory) == "" {
			http.Error(w, `{"error":"rep_tiers.payout_per_memory is required"}`, http.StatusBadRequest)
			return
		}
	}

	currentConfig, err := chainClient.GetOrgConfigFromChain(r.Context(), orgID)
	if err != nil {
		http.Error(w, `{"error":"failed to fetch chain org config"}`, http.StatusBadGateway)
		return
	}
	if currentConfig == nil {
		http.Error(w, `{"error":"org config not found on chain"}`, http.StatusNotFound)
		return
	}

	minContrib := currentConfig.MinContributionsPerEpoch
	if req.MinContributionsPerEpoch != nil {
		minContrib = *req.MinContributionsPerEpoch
	}

	contestStake := currentConfig.ContestStakeVibe
	if req.ContestStakeVibe != nil {
		contestStake = *req.ContestStakeVibe
	}

	tiers := make([]*types.RepTier, 0, len(req.RepTiers))
	for _, tier := range req.RepTiers {
		tiers = append(tiers, &types.RepTier{
			MinReputation:            tier.MinReputation,
			MaxReputation:            tier.MaxReputation,
			MaxContributionsPerEpoch: tier.MaxContributionsPerEpoch,
			PayoutPerMemory:          tier.PayoutPerMemory,
		})
	}

	txHash, err := chainClient.UpdateOrgChainConfig(
		r.Context(),
		orgID,
		req.ServeAttestationRequired,
		minContrib,
		contestStake,
		tiers,
	)
	if err != nil {
		http.Error(w, `{"error":"failed to broadcast chain config update"}`, http.StatusBadGateway)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"status":                      "updated",
		"tx_hash":                     txHash,
		"org_id":                      orgID,
		"serve_attestation_required":  req.ServeAttestationRequired,
		"min_contributions_per_epoch": minContrib,
		"contest_stake_vibe":          contestStake,
		"rep_tiers":                   tiers,
	})
}
