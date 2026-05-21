package reports

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	allowedReasons = map[string]bool{
		"incorrect":     true,
		"outdated":      true,
		"security_risk": true,
		"malicious":     true,
	}
	defaultEscalationQuorum = 2
)

func normalizeReason(reason string) (string, error) {
	reason = strings.ToLower(strings.TrimSpace(reason))
	if !allowedReasons[reason] {
		return "", fmt.Errorf("invalid reason: %s", reason)
	}
	return reason, nil
}

func Create(ctx context.Context, pool *pgxpool.Pool, orgID string, req protocol.CreateReportRequest, reporterPubkey, reporterRole string) (*protocol.ReportRecord, error) {
	reason, err := normalizeReason(req.Reason)
	if err != nil {
		return nil, err
	}

	var note *string
	if trimmed := strings.TrimSpace(req.Note); trimmed != "" {
		note = &trimmed
	}

	var reporterWallet *string
	if trimmed := strings.TrimSpace(req.ReporterWallet); trimmed != "" {
		reporterWallet = &trimmed
	}

	row := pool.QueryRow(ctx, `
		INSERT INTO reports (org_id, memory_cid, reporter_pubkey, reporter_wallet, reporter_role, reason, note)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING id, org_id, memory_cid, reporter_pubkey, reporter_wallet, reporter_role, reason, note,
		         status, resolution, resolved_by, resolved_at, escalation_votes, created_at, updated_at
	`,
		orgID, req.MemoryCID, reporterPubkey, reporterWallet, reporterRole, reason, note,
	)

	return scanReport(row)
}

func List(ctx context.Context, pool *pgxpool.Pool, orgID string, status *string, limit, offset int) ([]protocol.ReportRecord, int, error) {
	args := []any{orgID}
	where := "WHERE org_id = $1"
	if status != nil && *status != "" {
		where += " AND status = $2"
		args = append(args, *status)
	}

	countQuery := fmt.Sprintf("SELECT COUNT(*) FROM reports %s", where)
	var total int
	if err := pool.QueryRow(ctx, countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	var reportVoteThreshold int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(report_vote_threshold, 1) FROM orgs WHERE org_id = $1
	`, orgID).Scan(&reportVoteThreshold)
	if err != nil {
		reportVoteThreshold = 1
	}

	args = append(args, limit, offset)
	listQuery := fmt.Sprintf(`
		SELECT r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		       r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		       COUNT(rv.report_id) as vote_count,
		       COALESCE(m.dismissed_reports_count, 0) as reporter_dismissed_count
		FROM reports r
		LEFT JOIN report_votes rv ON rv.org_id = r.org_id AND rv.report_id = r.id
		LEFT JOIN members m ON m.org_id = r.org_id AND m.pubkey = r.reporter_pubkey
		%s
		GROUP BY r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		         r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		         m.dismissed_reports_count
		ORDER BY r.created_at DESC
		LIMIT $%d OFFSET $%d
	`, where, len(args)-1, len(args))

	rows, err := pool.Query(ctx, listQuery, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var records []protocol.ReportRecord
	for rows.Next() {
		rec, err := scanReportWithVotes(rows, reportVoteThreshold)
		if err != nil {
			return nil, 0, err
		}
		records = append(records, *rec)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}

	return records, total, nil
}

func Get(ctx context.Context, pool *pgxpool.Pool, orgID, reportID string) (*protocol.ReportRecord, error) {
	var reportVoteThreshold int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(report_vote_threshold, 1) FROM orgs WHERE org_id = $1
	`, orgID).Scan(&reportVoteThreshold)
	if err != nil {
		reportVoteThreshold = 1
	}

	row := pool.QueryRow(ctx, `
		SELECT r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		       r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		       COUNT(rv.report_id) as vote_count,
		       COALESCE(m.dismissed_reports_count, 0) as reporter_dismissed_count
		FROM reports r
		LEFT JOIN report_votes rv ON rv.org_id = r.org_id AND rv.report_id = r.id
		LEFT JOIN members m ON m.org_id = r.org_id AND m.pubkey = r.reporter_pubkey
		WHERE r.org_id = $1 AND r.id = $2
		GROUP BY r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		         r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		         m.dismissed_reports_count
	`, orgID, reportID)
	return scanReportWithVotes(row, reportVoteThreshold)
}

func Update(ctx context.Context, pool *pgxpool.Pool, orgID, reportID string, actorPubkey, actorRole string, req protocol.UpdateReportRequest, quorum int) (*protocol.ReportRecord, error) {
	vote := strings.ToLower(strings.TrimSpace(req.Vote))
	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))

	if vote == "" && resolution == "" {
		return nil, errors.New("either vote or resolution is required")
	}

	if quorum <= 0 {
		quorum = defaultEscalationQuorum
	}

	var reportVoteThreshold int
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(report_vote_threshold, 1) FROM orgs WHERE org_id = $1
	`, orgID).Scan(&reportVoteThreshold)
	if err != nil {
		reportVoteThreshold = 1
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	var (
		currStatus      string
		currResolution  sql.NullString
		currResolvedBy  sql.NullString
		currResolvedAt  sql.NullTime
		escVotesJSON    []byte
		currNote        sql.NullString
		reporterPubkey  string
	)
	row := tx.QueryRow(ctx, `
		SELECT status, resolution, resolved_by, resolved_at, escalation_votes, note, reporter_pubkey
		FROM reports
		WHERE org_id = $1 AND id = $2
		FOR UPDATE
	`, orgID, reportID)

	if err := row.Scan(&currStatus, &currResolution, &currResolvedBy, &currResolvedAt, &escVotesJSON, &currNote, &reporterPubkey); err != nil {
		if err == pgx.ErrNoRows {
			return nil, err
		}
		return nil, fmt.Errorf("load report: %w", err)
	}

	if currStatus != "pending" {
		return nil, fmt.Errorf("report already resolved")
	}

	if vote != "" {
		validVotes := map[string]struct{}{
			"uphold":            {},
			"dismiss":           {},
			"dismiss_malicious": {},
		}
		if _, ok := validVotes[vote]; !ok {
			return nil, fmt.Errorf("invalid vote: %s", vote)
		}

		_, err = tx.Exec(ctx, `
			INSERT INTO report_votes (org_id, report_id, voter_pubkey, vote)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (org_id, report_id, voter_pubkey) DO UPDATE SET vote = $4, created_at = NOW()
		`, orgID, reportID, actorPubkey, vote)
		if err != nil {
			return nil, fmt.Errorf("insert vote: %w", err)
		}

		var upholdCount, dismissCount, dismissMalCount int
		err = tx.QueryRow(ctx, `
			SELECT
				COUNT(*) FILTER (WHERE vote = 'uphold'),
				COUNT(*) FILTER (WHERE vote = 'dismiss'),
				COUNT(*) FILTER (WHERE vote = 'dismiss_malicious')
			FROM report_votes WHERE org_id = $1 AND report_id = $2
		`, orgID, reportID).Scan(&upholdCount, &dismissCount, &dismissMalCount)
		if err != nil {
			return nil, fmt.Errorf("count votes: %w", err)
		}

		if float64(upholdCount) >= float64(reportVoteThreshold)*0.5 {
			resolution = "upheld"
		} else if float64(dismissCount+dismissMalCount) >= float64(reportVoteThreshold)*0.5 {
			resolution = "dismiss"
			if vote == "dismiss_malicious" {
				resolution = "dismissed_malicious"
			}
		}
	}

	if resolution == "" {
		return getReportRecordTx(ctx, tx, orgID, reportID, reportVoteThreshold)
	}

	if resolution == "upheld" {
		_, err = tx.Exec(ctx, `
			DELETE FROM reports WHERE org_id = $1 AND id = $2
		`, orgID, reportID)
		if err != nil {
			return nil, fmt.Errorf("mark report upheld: %w", err)
		}
	} else {
		_, err = tx.Exec(ctx, `
			UPDATE reports SET status = $1, resolution = $2, resolved_by = $3, resolved_at = $4, updated_at = NOW()
			WHERE org_id = $5 AND id = $6
		`, "resolved", resolution, actorPubkey, time.Now().UTC(), orgID, reportID)
		if err != nil {
			return nil, fmt.Errorf("update report: %w", err)
		}

		if resolution == "dismissed" || resolution == "dismissed_malicious" {
			_, err = tx.Exec(ctx, `
				UPDATE members SET dismissed_reports_count = dismissed_reports_count + 1
				WHERE org_id = $1 AND pubkey = $2 AND active = true
			`, orgID, reporterPubkey)
			if err != nil {
				return nil, fmt.Errorf("increment dismissed count: %w", err)
			}
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}

	return getReportRecord(ctx, pool, orgID, reportID, reportVoteThreshold)
}

func getReportRecord(ctx context.Context, pool *pgxpool.Pool, orgID, reportID string, reportVoteThreshold int) (*protocol.ReportRecord, error) {
	row := pool.QueryRow(ctx, `
		SELECT r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		       r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		       COUNT(rv.report_id) as vote_count,
		       COALESCE(m.dismissed_reports_count, 0) as reporter_dismissed_count
		FROM reports r
		LEFT JOIN report_votes rv ON rv.org_id = r.org_id AND rv.report_id = r.id
		LEFT JOIN members m ON m.org_id = r.org_id AND m.pubkey = r.reporter_pubkey
		WHERE r.org_id = $1 AND r.id = $2
		GROUP BY r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		         r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		         m.dismissed_reports_count
	`, orgID, reportID)
	return scanReportWithVotes(row, reportVoteThreshold)
}

func getReportRecordTx(ctx context.Context, tx pgx.Tx, orgID, reportID string, reportVoteThreshold int) (*protocol.ReportRecord, error) {
	row := tx.QueryRow(ctx, `
		SELECT r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		       r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		       COUNT(rv.report_id) as vote_count,
		       COALESCE(m.dismissed_reports_count, 0) as reporter_dismissed_count
		FROM reports r
		LEFT JOIN report_votes rv ON rv.org_id = r.org_id AND rv.report_id = r.id
		LEFT JOIN members m ON m.org_id = r.org_id AND m.pubkey = r.reporter_pubkey
		WHERE r.org_id = $1 AND r.id = $2
		GROUP BY r.id, r.org_id, r.memory_cid, r.reporter_pubkey, r.reporter_wallet, r.reporter_role, r.reason, r.note,
		         r.status, r.resolution, r.resolved_by, r.resolved_at, r.escalation_votes, r.created_at, r.updated_at,
		         m.dismissed_reports_count
	`, orgID, reportID)
	return scanReportWithVotes(row, reportVoteThreshold)
}

func scanReport(row pgx.Row) (*protocol.ReportRecord, error) {
	var (
		id             string
		orgID          string
		memoryCID      string
		reporterPubkey string
		reporterWallet sql.NullString
		reporterRole   string
		reason         string
		noteSQL        sql.NullString
		status         string
		resolutionSQL  sql.NullString
		resolvedBySQL  sql.NullString
		resolvedAtSQL  sql.NullTime
		escVotesJSON   []byte
		createdAt      time.Time
		updatedAt      time.Time
	)

	if err := row.Scan(
		&id,
		&orgID,
		&memoryCID,
		&reporterPubkey,
		&reporterWallet,
		&reporterRole,
		&reason,
		&noteSQL,
		&status,
		&resolutionSQL,
		&resolvedBySQL,
		&resolvedAtSQL,
		&escVotesJSON,
		&createdAt,
		&updatedAt,
	); err != nil {
		return nil, err
	}

	var votes []protocol.EscalationVote
	if len(escVotesJSON) > 0 {
		if err := json.Unmarshal(escVotesJSON, &votes); err != nil {
			return nil, fmt.Errorf("decode votes: %w", err)
		}
	}

	var note *string
	if noteSQL.Valid {
		val := noteSQL.String
		note = &val
	}

	var resolution *string
	if resolutionSQL.Valid {
		val := resolutionSQL.String
		resolution = &val
	}

	var resolvedBy *string
	if resolvedBySQL.Valid {
		val := resolvedBySQL.String
		resolvedBy = &val
	}

	var resolvedAt *time.Time
	if resolvedAtSQL.Valid {
		val := resolvedAtSQL.Time
		resolvedAt = &val
	}

	var wallet *string
	if reporterWallet.Valid {
		val := reporterWallet.String
		wallet = &val
	}

	return &protocol.ReportRecord{
		ID:                   id,
		OrgID:                orgID,
		MemoryCID:            memoryCID,
		ReporterPubkey:       reporterPubkey,
		ReporterWallet:       wallet,
		ReporterRole:         reporterRole,
		Reason:               reason,
		Note:                 note,
		Status:               status,
		Resolution:           resolution,
		ResolvedBy:           resolvedBy,
		ResolvedAt:           resolvedAt,
		EscalationVotes:      votes,
		VoteCount:            0,
		ReportVoteThreshold:  1,
		ReporterDismissedCount: 0,
		CreatedAt:            createdAt,
		UpdatedAt:            updatedAt,
	}, nil
}

func scanReportWithVotes(row pgx.Row, reportVoteThreshold int) (*protocol.ReportRecord, error) {
	var (
		id                      string
		orgID                   string
		memoryCID               string
		reporterPubkey          string
		reporterWallet          sql.NullString
		reporterRole            string
		reason                  string
		noteSQL                 sql.NullString
		status                  string
		resolutionSQL           sql.NullString
		resolvedBySQL           sql.NullString
		resolvedAtSQL           sql.NullTime
		escVotesJSON            []byte
		createdAt               time.Time
		updatedAt               time.Time
		voteCount               int
		reporterDismissedCount  int
	)

	if err := row.Scan(
		&id,
		&orgID,
		&memoryCID,
		&reporterPubkey,
		&reporterWallet,
		&reporterRole,
		&reason,
		&noteSQL,
		&status,
		&resolutionSQL,
		&resolvedBySQL,
		&resolvedAtSQL,
		&escVotesJSON,
		&createdAt,
		&updatedAt,
		&voteCount,
		&reporterDismissedCount,
	); err != nil {
		return nil, err
	}

	var votes []protocol.EscalationVote
	if len(escVotesJSON) > 0 {
		if err := json.Unmarshal(escVotesJSON, &votes); err != nil {
			return nil, fmt.Errorf("decode votes: %w", err)
		}
	}

	var note *string
	if noteSQL.Valid {
		val := noteSQL.String
		note = &val
	}

	var resolution *string
	if resolutionSQL.Valid {
		val := resolutionSQL.String
		resolution = &val
	}

	var resolvedBy *string
	if resolvedBySQL.Valid {
		val := resolvedBySQL.String
		resolvedBy = &val
	}

	var resolvedAt *time.Time
	if resolvedAtSQL.Valid {
		val := resolvedAtSQL.Time
		resolvedAt = &val
	}

	var wallet *string
	if reporterWallet.Valid {
		val := reporterWallet.String
		wallet = &val
	}

	return &protocol.ReportRecord{
		ID:                   id,
		OrgID:                orgID,
		MemoryCID:            memoryCID,
		ReporterPubkey:       reporterPubkey,
		ReporterWallet:       wallet,
		ReporterRole:         reporterRole,
		Reason:               reason,
		Note:                 note,
		Status:               status,
		Resolution:           resolution,
		ResolvedBy:           resolvedBy,
		ResolvedAt:           resolvedAt,
		EscalationVotes:      votes,
		VoteCount:            voteCount,
		ReportVoteThreshold:  reportVoteThreshold,
		ReporterDismissedCount: reporterDismissedCount,
		CreatedAt:            createdAt,
		UpdatedAt:            updatedAt,
	}, nil
}
