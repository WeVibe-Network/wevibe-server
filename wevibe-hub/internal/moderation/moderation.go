package moderation

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func SubmitToQueue(ctx context.Context, pool *pgxpool.Pool, req protocol.SubmitMemoryRequest, sanitizationFindings []byte) error {
	if !protocol.IsValidMemoryType(req.MemoryType) {
		return fmt.Errorf("invalid memory_type: %s", req.MemoryType)
	}

	if _, err := hex.DecodeString(req.SubmissionHash); err != nil {
		return fmt.Errorf("invalid submission_hash: %w", err)
	}

	canonical := verify.SubmitMemoryMessage(req.OrgID, req.EpochID, req.SubmissionHash, req.ContributorPubkey, req.MemoryType)
	if err := verify.RequestSignature(req.ContributorPubkey, req.ContributorSig, canonical); err != nil {
		return fmt.Errorf("signature verification failed: %w", err)
	}

	ciphertextBytes, err := hex.DecodeString(req.Ciphertext)
	if err != nil {
		return fmt.Errorf("invalid ciphertext hex: %w", err)
	}
	wrappedDekBytes, err := hex.DecodeString(req.WrappedDekMod)
	if err != nil {
		return fmt.Errorf("invalid wrapped_dek_mod hex: %w", err)
	}
	combined := append(ciphertextBytes, wrappedDekBytes...)
	computed := sha256.Sum256(combined)
	computedHex := hex.EncodeToString(computed[:])
	if computedHex != req.SubmissionHash {
		return fmt.Errorf("submission_hash mismatch")
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO pending_submissions
			(submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex,
			 wrapped_dek_mod, contributor_sig, stack_hint, memory_type, sanitization_findings)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
	`,
		req.SubmissionHash, req.OrgID, req.EpochID, req.ContributorPubkey,
		req.Ciphertext,
		req.WrappedDekMod, req.ContributorSig, req.StackHint, req.MemoryType,
		sanitizationFindings,
	)
	return err
}

func GetPendingQueue(ctx context.Context, pool *pgxpool.Pool, orgID, moderatorPubkey string) ([]protocol.PendingQueueItem, error) {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil {
		return nil, fmt.Errorf("member not found or inactive")
	}
	if role != "moderator" && role != "leader" {
		return nil, fmt.Errorf("insufficient role: %s", role)
	}

	rows, err := pool.Query(ctx, `
        SELECT ps.submission_hash, ps.org_id, ps.epoch_id, ps.contributor_pubkey,
               COALESCE(m.wallet_address, '') AS contributor_wallet,
               ps.ciphertext_hex, ps.wrapped_dek_mod,
               ps.stack_hint, ps.memory_type, ps.created_at, ps.status,
               COALESCE(v.vote_count, 0) AS vote_count,
               o.required_approvals,
               COALESCE(v.voter_pubkeys, ARRAY[]::TEXT[]) AS voter_pubkeys
        FROM pending_submissions ps
        JOIN orgs o ON o.org_id = ps.org_id
        LEFT JOIN members m ON m.org_id = ps.org_id AND m.pubkey = ps.contributor_pubkey
        LEFT JOIN (
            SELECT org_id, submission_hash, COUNT(*) AS vote_count,
                   ARRAY_AGG(moderator_pubkey ORDER BY moderator_pubkey) AS voter_pubkeys
            FROM approval_votes
            GROUP BY org_id, submission_hash
        ) v ON v.org_id = ps.org_id AND v.submission_hash = ps.submission_hash
        WHERE ps.org_id = $1 AND ps.status = 'pending'
        ORDER BY ps.created_at ASC
    `, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := []protocol.PendingQueueItem{}
	for rows.Next() {
		var item protocol.PendingQueueItem
		if err := rows.Scan(
			&item.SubmissionHash, &item.OrgID, &item.EpochID,
			&item.ContributorPubkey, &item.ContributorWallet, &item.CiphertextHex, &item.WrappedDekMod,
			&item.StackHint, &item.MemoryType, &item.CreatedAt, &item.Status,
			&item.Votes, &item.RequiredApprovals, &item.VoterPubkeys,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func CastApprovalVote(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey string) (currentVotes int, required int, ready bool, err error) {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil {
		return 0, 0, false, fmt.Errorf("member not found or inactive")
	}
	if role != "moderator" && role != "leader" {
		return 0, 0, false, fmt.Errorf("insufficient role: %s", role)
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, 0, false, err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `
        SELECT status FROM pending_submissions
        WHERE org_id = $1 AND submission_hash = $2
        FOR UPDATE
    `, orgID, submissionHash).Scan(&status)
	if err == pgx.ErrNoRows {
		return 0, 0, false, fmt.Errorf("submission not found")
	}
	if err != nil {
		return 0, 0, false, err
	}

	switch status {
	case protocol.SubmissionStatusCommitted, protocol.SubmissionStatusDenied:
		return 0, 0, false, fmt.Errorf("submission already resolved")
	}

	if role == "leader" {
		_, err = tx.Exec(ctx, `
            UPDATE pending_submissions
            SET status = $3, updated_at = NOW()
            WHERE org_id = $1 AND submission_hash = $2
        `, orgID, submissionHash, protocol.SubmissionStatusPendingKeyword)
		if err != nil {
			return 0, 0, false, err
		}
		_, err = tx.Exec(ctx, `
            DELETE FROM approval_votes WHERE org_id = $1 AND submission_hash = $2
        `, orgID, submissionHash)
		if err != nil {
			return 0, 0, false, err
		}
		err = tx.QueryRow(ctx, `
            SELECT required_approvals FROM orgs WHERE org_id = $1
        `, orgID).Scan(&required)
		if err != nil {
			return 0, 0, false, err
		}
		if required < 1 {
			required = 1
		}
		ready = true
		currentVotes = 0
	} else {
		result, err := tx.Exec(ctx, `
            INSERT INTO approval_votes (org_id, submission_hash, moderator_pubkey)
            VALUES ($1, $2, $3)
            ON CONFLICT DO NOTHING
        `, orgID, submissionHash, moderatorPubkey)
		if err != nil {
			return 0, 0, false, err
		}
		if result.RowsAffected() == 0 {
			return 0, 0, false, fmt.Errorf("vote already recorded")
		}

		err = tx.QueryRow(ctx, `
            SELECT COUNT(*) FROM approval_votes
            WHERE org_id = $1 AND submission_hash = $2
        `, orgID, submissionHash).Scan(&currentVotes)
		if err != nil {
			return 0, 0, false, err
		}

		err = tx.QueryRow(ctx, `
            SELECT required_approvals FROM orgs WHERE org_id = $1
        `, orgID).Scan(&required)
		if err != nil {
			return 0, 0, false, err
		}
		if required < 1 {
			required = 1
		}
		if currentVotes >= required {
			_, err = tx.Exec(ctx, `
                UPDATE pending_submissions
                SET status = $3, updated_at = NOW()
                WHERE org_id = $1 AND submission_hash = $2
            `, orgID, submissionHash, protocol.SubmissionStatusPendingKeyword)
			if err != nil {
				return 0, 0, false, err
			}
			ready = true
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, false, err
	}

	// If status was already pending_keyword when vote cast (e.g., due to prior quorum), return latest counts.
	if role != "leader" && status == protocol.SubmissionStatusPendingKeyword && !ready {
		// Fetch counts to report current state.
		err = pool.QueryRow(ctx, `
            SELECT COUNT(*) FROM approval_votes
            WHERE org_id = $1 AND submission_hash = $2
        `, orgID, submissionHash).Scan(&currentVotes)
		if err != nil {
			return currentVotes, required, true, nil
		}
		ready = true
	}

	return currentVotes, required, ready, nil
}

func ApproveSubmission(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey, memoryType string) error {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil || (role != "moderator" && role != "leader") {
		return fmt.Errorf("forbidden: not authorized")
	}
	if !protocol.IsValidMemoryType(memoryType) {
		return fmt.Errorf("invalid memory_type: %s", memoryType)
	}

	var currentStatus string
	err = pool.QueryRow(ctx, `
        SELECT status FROM pending_submissions WHERE submission_hash = $1 AND org_id = $2
    `, submissionHash, orgID).Scan(&currentStatus)
	if err == pgx.ErrNoRows {
		return fmt.Errorf("submission not found")
	}
	if err != nil {
		return err
	}

	if currentStatus != "pending" {
		return fmt.Errorf("invalid status for approval: %s (expected 'pending')", currentStatus)
	}

	result, err := pool.Exec(ctx, `
        UPDATE pending_submissions
		SET status = 'pending_keyword',
		    moderator_pubkey = $1,
		    memory_type = $4,
		    approved_at = NOW(),
		    updated_at = NOW()
		WHERE submission_hash = $2 AND org_id = $3 AND status = 'pending'
	`, moderatorPubkey, submissionHash, orgID, memoryType)
	if err != nil {
		return fmt.Errorf("update submission: %w", err)
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("submission not found or status changed")
	}

	_, _ = pool.Exec(ctx, `
        DELETE FROM approval_votes WHERE org_id = $1 AND submission_hash = $2
    `, orgID, submissionHash)

	return nil
}

func DenySubmission(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey, reason string) error {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil || (role != "moderator" && role != "leader") {
		return fmt.Errorf("forbidden")
	}

	result, err := pool.Exec(ctx, `
		UPDATE pending_submissions
		SET status = $1, denial_reason = $2, moderator_pubkey = $3, resolved_at = NOW()
		WHERE submission_hash = $4 AND org_id = $5 AND status = 'pending'
	`, protocol.SubmissionStatusDenied, reason, moderatorPubkey, submissionHash, orgID)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("submission not found or already resolved")
	}
	return nil
}

func UndoApproveSubmission(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey string) error {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil || (role != "moderator" && role != "leader") {
		return fmt.Errorf("forbidden: not authorized")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `
		SELECT status FROM pending_submissions
		WHERE org_id = $1 AND submission_hash = $2
		FOR UPDATE
	`, orgID, submissionHash).Scan(&status)
	if err == pgx.ErrNoRows {
		return fmt.Errorf("submission not found")
	}
	if err != nil {
		return err
	}
	if status != "pending_keyword" {
		return fmt.Errorf("memory is not in pending_keyword state; undo not available (current status: %s)", status)
	}

	result, err := tx.Exec(ctx, `
		UPDATE pending_submissions
		SET status = 'pending',
		    moderator_pubkey = NULL,
		    approved_at = NULL,
		    updated_at = NOW()
		WHERE org_id = $1 AND submission_hash = $2 AND status = 'pending_keyword'
	`, orgID, submissionHash)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("status changed during undo; retry required")
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO audit_log (org_id, epoch_id, event_type, actor_pubkey, encrypted_entry)
		VALUES ($1, 0, 'undo_approve', $2, $3)
	`, orgID, moderatorPubkey, fmt.Sprintf("undo_approve|%s|%s", submissionHash, time.Now().Format(time.RFC3339)))
	if err != nil {
		return fmt.Errorf("audit log: %w", err)
	}

	return tx.Commit(ctx)
}
