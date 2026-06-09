package chain

import (
	"context"
	"fmt"
	"log"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type hubActiveMember struct {
	role           string
	chainConfirmed bool
}

func ReconcileMembership(ctx context.Context, chainClient *GrpcClient, pool *pgxpool.Pool) error {
	if chainClient == nil {
		return fmt.Errorf("chain client unavailable")
	}
	if pool == nil {
		return fmt.Errorf("database pool unavailable")
	}

	orgIDs, err := loadNonClosedOrgIDs(ctx, pool)
	if err != nil {
		return fmt.Errorf("load non-closed org ids: %w", err)
	}

	orgsReconciled := 0
	rolesHealed := 0
	divergencesLogged := 0
	staleReverted := 0

	for _, orgID := range orgIDs {
		if err := ctx.Err(); err != nil {
			return err
		}

		orgsReconciled++

		chainMembers, err := chainClient.GetOrgMembersFromChain(ctx, orgID)
		if err != nil {
			log.Printf("WARNING: membership reconcile chain query failed for org=%s: %v", orgID, err)
			continue
		}

		chainByPubkey := make(map[string]string, len(chainMembers))
		for _, member := range chainMembers {
			pubkey := strings.TrimSpace(member.Pubkey)
			if pubkey == "" {
				continue
			}
			chainByPubkey[pubkey] = strings.TrimSpace(member.Role)
		}

		hubMembers, err := loadHubActiveMembers(ctx, pool, orgID)
		if err != nil {
			log.Printf("WARNING: membership reconcile hub member query failed for org=%s: %v", orgID, err)
			continue
		}

		for pubkey, chainRole := range chainByPubkey {
			hubMember, exists := hubMembers[pubkey]
			if !exists {
				log.Printf("WARNING: chain member missing from hub; cannot provision without crypto (org_id=%s pubkey=%s)", orgID, pubkey)
				divergencesLogged++
				continue
			}

			if hubMember.role != chainRole {
				if _, err := pool.Exec(ctx, `
					UPDATE members
					SET role = $1,
					    chain_confirmed = TRUE,
					    updated_at = NOW()
					WHERE org_id = $2 AND pubkey = $3
				`, chainRole, orgID, pubkey); err != nil {
					log.Printf("WARNING: membership reconcile role heal failed for org=%s pubkey=%s: %v", orgID, pubkey, err)
					continue
				}
				rolesHealed++
				hubMember.role = chainRole
				hubMember.chainConfirmed = true
				hubMembers[pubkey] = hubMember
				continue
			}

			if !hubMember.chainConfirmed {
				if _, err := pool.Exec(ctx, `
					UPDATE members
					SET chain_confirmed = TRUE,
					    updated_at = NOW()
					WHERE org_id = $1 AND pubkey = $2
				`, orgID, pubkey); err != nil {
					log.Printf("WARNING: membership reconcile chain_confirmed heal failed for org=%s pubkey=%s: %v", orgID, pubkey, err)
					continue
				}
				hubMember.chainConfirmed = true
				hubMembers[pubkey] = hubMember
			}
		}

		for pubkey, hubMember := range hubMembers {
			if _, exists := chainByPubkey[pubkey]; exists {
				continue
			}
			log.Printf("WARNING: hub member not found on chain — possible divergence (org_id=%s pubkey=%s chain_confirmed=%t)", orgID, pubkey, hubMember.chainConfirmed)
			divergencesLogged++
		}

		staleTag, err := pool.Exec(ctx, `
			UPDATE join_requests
			SET status='pending',
			    reviewed_by=NULL,
			    reviewed_at=NULL,
			    approval_tier=NULL,
			    approval_is_trial=FALSE
			WHERE org_id=$1
			  AND status='confirming'
			  AND reviewed_at < NOW() - INTERVAL '10 minutes'
		`, orgID)
		if err != nil {
			log.Printf("WARNING: membership reconcile stale confirming revert failed for org=%s: %v", orgID, err)
			continue
		}
		staleReverted += int(staleTag.RowsAffected())
	}

	log.Printf("membership reconcile summary: orgs_reconciled=%d roles_healed=%d divergences_logged=%d stale_reverted=%d", orgsReconciled, rolesHealed, divergencesLogged, staleReverted)
	return nil
}

func loadNonClosedOrgIDs(ctx context.Context, pool *pgxpool.Pool) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT org_id
		FROM orgs
		WHERE status <> 'closed'
		ORDER BY org_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	orgIDs := make([]string, 0)
	for rows.Next() {
		var orgID string
		if err := rows.Scan(&orgID); err != nil {
			return nil, err
		}
		orgIDs = append(orgIDs, orgID)
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return orgIDs, nil
}

func loadHubActiveMembers(ctx context.Context, pool *pgxpool.Pool, orgID string) (map[string]hubActiveMember, error) {
	rows, err := pool.Query(ctx, `
		SELECT pubkey, role, chain_confirmed
		FROM members
		WHERE org_id=$1 AND active=true
	`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make(map[string]hubActiveMember)
	for rows.Next() {
		var pubkey string
		var role string
		var chainConfirmed bool
		if err := rows.Scan(&pubkey, &role, &chainConfirmed); err != nil {
			return nil, err
		}
		members[pubkey] = hubActiveMember{role: role, chainConfirmed: chainConfirmed}
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return members, nil
}
