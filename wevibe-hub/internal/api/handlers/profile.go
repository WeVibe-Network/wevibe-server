package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProfileResponse struct {
	Wallet         string            `json:"wallet"`
	DisplayName    *string           `json:"display_name,omitempty"`
	Pubkey         *string           `json:"pubkey"`
	Memberships    []MembershipEntry `json:"memberships"`
	ChainStats     *ChainStats       `json:"chain_stats"`
	ModeratorStats *ModeratorStats   `json:"moderator_stats"`
	LeaderStats    *LeaderStats      `json:"leader_stats"`
}

type MembershipEntry struct {
	OrgID    string    `json:"org_id"`
	OrgName  string    `json:"org_name"`
	Role     string    `json:"role"`
	JoinedAt time.Time `json:"joined_at"`
}

type ChainStats struct {
	TotalApprovedMemories uint64  `json:"total_approved_memories"`
	TotalServes           uint64  `json:"total_serves"`
	FirstSeenEpoch        uint64  `json:"first_seen_epoch"`
	ReputationTier        *string `json:"reputation_tier"`
}

type ModeratorStats struct {
	TotalApprovals     uint64 `json:"total_approvals"`
	TotalUpheldReports uint64 `json:"total_upheld_reports"`
}

type LeaderStats struct {
	TotalChainCommits   uint64 `json:"total_chain_commits"`
	TotalEpochRotations uint64 `json:"total_epoch_rotations"`
}

func GetProfile(w http.ResponseWriter, r *http.Request) {
	walletOrPubkey := strings.TrimSpace(chi.URLParam(r, "wallet"))
	if walletOrPubkey == "" {
		http.Error(w, `{"error":"wallet required"}`, http.StatusBadRequest)
		return
	}

	wallet := walletOrPubkey
	var pubkey *string
	var displayName *string
	memberships := []MembershipEntry{}

	if pool != nil {
		pubkeyFromWallet, err := resolveWalletToPubkey(r.Context(), pool, walletOrPubkey)
		if err == nil && pubkeyFromWallet != "" {
			pubkey = &pubkeyFromWallet
		} else {
			pubkey = &walletOrPubkey
			walletFromPubkey, walletErr := resolvePubkeyToWallet(r.Context(), pool, walletOrPubkey)
			if walletErr == nil && walletFromPubkey != "" {
				wallet = walletFromPubkey
			}
		}

		if pubkey != nil {
			if entries, err := members.ListOrgsForMember(r.Context(), pool, *pubkey); err == nil {
				for _, e := range entries {
					memberships = append(memberships, MembershipEntry{
						OrgID:    e.OrgID,
						OrgName:  e.OrgName,
						Role:     e.Role,
						JoinedAt: time.Now(),
					})
				}
			}
		}

		if socialClient != nil && wallet != "" {
			if profile, err := socialClient.GetProfile(r.Context(), wallet); err == nil && profile != nil {
				if trimmed := strings.TrimSpace(profile.DisplayName); trimmed != "" {
					displayName = &trimmed
				}
			}
		}
	}

	var chainStats *ChainStats
	if chainClient != nil {
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		chainProfile, err := chainClient.GetContributorProfile(ctx, wallet, 0)
		if err == nil && chainProfile != nil {
			chainStats = &ChainStats{
				TotalApprovedMemories: chainProfile.TotalApprovedMemories,
				TotalServes:           0,
				FirstSeenEpoch:        0,
				ReputationTier:        nil,
			}
		}
	}

	resp := ProfileResponse{
		Wallet:         wallet,
		DisplayName:    displayName,
		Pubkey:         pubkey,
		Memberships:    memberships,
		ChainStats:     chainStats,
		ModeratorStats: nil,
		LeaderStats:    nil,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func resolvePubkeyToWallet(ctx context.Context, pool *pgxpool.Pool, pubkey string) (string, error) {
	var wallet string
	err := pool.QueryRow(ctx, `
		SELECT wallet_address FROM members
		WHERE pubkey = $1 AND active = true AND wallet_address IS NOT NULL
		LIMIT 1
	`, pubkey).Scan(&wallet)
	if err != nil {
		return "", err
	}
	return wallet, nil
}

func resolveWalletToPubkey(ctx context.Context, pool *pgxpool.Pool, wallet string) (string, error) {
	var delegatePubkey string
	err := pool.QueryRow(ctx, `
		SELECT delegate_pubkey FROM delegate_keys
		WHERE wallet_address = $1 AND active = true
		LIMIT 1
	`, wallet).Scan(&delegatePubkey)
	if err != nil {
		return "", err
	}
	return delegatePubkey, nil
}
