package retrieval

import (
	"context"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-chain/x/reputation/types"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ChainQuerier interface {
	GetContributorProfile(ctx context.Context, contributorID string, epoch uint64) (*types.StoredContributorProfile, error)
}

func GetAcceptanceCount(ctx context.Context, pool *pgxpool.Pool, orgID, memoryCID string) (int, error) {
	var count int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM serve_events
		WHERE org_id = $1 AND memory_content_hash = $2
	`, orgID, memoryCID).Scan(&count)
	return count, err
}

func GetContributorStats(ctx context.Context, pool *pgxpool.Pool, chainClient ChainQuerier, orgID, contributorPubkey string) (*protocol.ContributorStats, error) {
	var joinedAt *time.Time
	err := pool.QueryRow(ctx, `SELECT joined_at FROM members WHERE org_id = $1 AND pubkey = $2`, orgID, contributorPubkey).Scan(&joinedAt)
	if err != nil {
		return nil, err
	}

	var chainContributorID string
	if chainClient != nil {
		walletAddr, walletErr := getWalletAddress(ctx, pool, orgID, contributorPubkey)
		if walletErr == nil && walletAddr != "" {
			chainContributorID = walletAddr
		} else {
			chainContributorID = contributorPubkey
		}
	}

	var chainProfile *types.StoredContributorProfile
	if chainClient != nil && chainContributorID != "" {
		chainProfile, _ = chainClient.GetContributorProfile(ctx, chainContributorID, 0)
	}

	var contributions int
	if chainProfile != nil {
		contributions = int(chainProfile.TotalApprovedMemories)
	} else {
		err = pool.QueryRow(ctx, `
			SELECT COUNT(*) FROM pending_submissions WHERE org_id = $1 AND contributor_pubkey = $2 AND status = 'approved'
		`, orgID, contributorPubkey).Scan(&contributions)
		if err != nil {
			return nil, err
		}
	}

	var serveCount int
	if chainProfile != nil {
		serveCount = int(chainProfile.TotalServesReceived)
	}

	var reportsUpheld int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM reports r
		JOIN pending_submissions p ON r.memory_cid = p.submission_hash
		WHERE p.org_id = $1 AND p.contributor_pubkey = $2 AND r.resolution = 'upheld'
	`, orgID, contributorPubkey).Scan(&reportsUpheld)
	if err != nil {
		return nil, err
	}

	var falseReports int
	err = pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM reports r
		JOIN pending_submissions p ON r.memory_cid = p.submission_hash
		WHERE p.org_id = $1 AND p.contributor_pubkey = $2 AND r.resolution = 'dismissed_malicious'
	`, orgID, contributorPubkey).Scan(&falseReports)
	if err != nil {
		return nil, err
	}

	accountAgeDays := 0
	if chainProfile != nil && chainProfile.FirstContributionEpoch > 0 {
		accountAgeDays = int(chainProfile.FirstContributionEpoch)
	} else if joinedAt != nil {
		accountAgeDays = int(time.Since(*joinedAt).Hours() / 24)
	}

	return &protocol.ContributorStats{
		AccountAgeDays:      accountAgeDays,
		Contributions:       contributions,
		ServeCount:          serveCount,
		ReportsUpheld:       reportsUpheld,
		FalseReportsAgainst: falseReports,
	}, nil
}

func getWalletAddress(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (string, error) {
	var wallet *string
	err := pool.QueryRow(ctx,
		`SELECT wallet_address FROM members WHERE org_id = $1 AND pubkey = $2`,
		orgID, pubkey).Scan(&wallet)
	if err != nil {
		return "", err
	}
	if wallet == nil {
		return "", nil
	}
	return *wallet, nil
}