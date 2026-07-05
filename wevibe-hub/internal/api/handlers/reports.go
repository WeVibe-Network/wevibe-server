package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/reports"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/wlog"
)

const (
	reportTimestampTolerance = 5 * time.Minute
	maxReportNoteLength      = 2000
	defaultReportListLimit   = 50
	maxReportListLimit       = 100
)

var (
	allowedReportReasons = map[string]struct{}{
		"incorrect":     {},
		"outdated":      {},
		"security_risk": {},
		"malicious":     {},
	}

	allowedReportStatuses = map[string]struct{}{
		"pending":             {},
		"upheld":              {},
		"dismissed":           {},
		"dismissed_malicious": {},
	}

	allowedReportActions = map[string]struct{}{
		"uphold":            {},
		"dismiss":           {},
		"dismiss_malicious": {},
	}
)

func CreateReport(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	reporterPubkey, reporterRole, err := authorizeReportActor(r, orgID, false)
	if err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	isTrial, err := isMemberOnTrial(r.Context(), pool, orgID, reporterPubkey)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}
	if isTrial {
		http.Error(w, `{"error":"trial members cannot submit reports"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req protocol.CreateReportRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	req.MemoryCID = strings.TrimSpace(req.MemoryCID)
	if req.MemoryCID == "" {
		http.Error(w, `{"error":"memory_cid required"}`, http.StatusBadRequest)
		return
	}

	req.Reason = strings.ToLower(strings.TrimSpace(req.Reason))
	if _, ok := allowedReportReasons[req.Reason]; !ok {
		http.Error(w, `{"error":"invalid reason"}`, http.StatusBadRequest)
		return
	}

	if len(req.Note) > maxReportNoteLength {
		http.Error(w, `{"error":"note too long"}`, http.StatusBadRequest)
		return
	}

	wallet, _ := getMemberWallet(r.Context(), pool, orgID, reporterPubkey)

	req.ReporterWallet = wallet
	req.ReporterPubkey = reporterPubkey

	var existingCount int
	err = pool.QueryRow(r.Context(), `
		SELECT COUNT(*) FROM reports
		WHERE org_id = $1 AND memory_cid = $2 AND reporter_pubkey = $3 AND status = 'pending'
	`, orgID, req.MemoryCID, reporterPubkey).Scan(&existingCount)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}
	if existingCount > 0 {
		http.Error(w, `{"error":"you have already reported this memory"}`, http.StatusConflict)
		return
	}

	rec, err := reports.Create(r.Context(), pool, orgID, req, reporterPubkey, reporterRole)
	if err != nil {
		http.Error(w, errorJSON(err.Error()), http.StatusBadRequest)
		return
	}

	response := map[string]any{
		"id":     rec.ID,
		"status": rec.Status,
	}

	writeJSON(w, http.StatusCreated, response)
}

func ListReports(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	if _, _, err := authorizeReportActor(r, orgID, true); err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	var statusFilter *string
	if statusParam := strings.TrimSpace(strings.ToLower(r.URL.Query().Get("status"))); statusParam != "" {
		if _, ok := allowedReportStatuses[statusParam]; !ok {
			http.Error(w, `{"error":"invalid status"}`, http.StatusBadRequest)
			return
		}
		statusFilter = &statusParam
	}

	limit := defaultReportListLimit
	if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
		parsed, err := strconv.Atoi(limitStr)
		if err != nil || parsed <= 0 {
			http.Error(w, `{"error":"invalid limit"}`, http.StatusBadRequest)
			return
		}
		if parsed > maxReportListLimit {
			parsed = maxReportListLimit
		}
		limit = parsed
	}

	offset := 0
	if offsetStr := r.URL.Query().Get("offset"); offsetStr != "" {
		parsed, err := strconv.Atoi(offsetStr)
		if err != nil || parsed < 0 {
			http.Error(w, `{"error":"invalid offset"}`, http.StatusBadRequest)
			return
		}
		offset = parsed
	}

	records, total, err := reports.List(r.Context(), pool, orgID, statusFilter, limit, offset)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	reportIDs := make([]string, 0, len(records))
	for _, record := range records {
		reportIDs = append(reportIDs, record.ID)
	}

	recommendationsByReport, err := reports.GetReportRecommendations(r.Context(), pool, orgID, reportIDs)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	for idx := range records {
		records[idx].ModeratorRecommendations = []protocol.ReportRecommendation{}
		if recommendations, ok := recommendationsByReport[records[idx].ID]; ok {
			records[idx].ModeratorRecommendations = recommendations
		}
	}

	writeJSON(w, http.StatusOK, protocol.ReportListResponse{Reports: records, Total: total})
}

func GetReport(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	reportID := chi.URLParam(r, "reportID")
	if orgID == "" || reportID == "" {
		http.Error(w, `{"error":"org_id and report_id required"}`, http.StatusBadRequest)
		return
	}

	if _, _, err := authorizeReportActor(r, orgID, true); err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	rec, err := reports.Get(r.Context(), pool, orgID, reportID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, `{"error":"report not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, rec)
}

func UpdateReport(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	reportID := chi.URLParam(r, "reportID")
	if orgID == "" || reportID == "" {
		http.Error(w, `{"error":"org_id and report_id required"}`, http.StatusBadRequest)
		return
	}

	actorPubkey, actorRole, err := authorizeReportActor(r, orgID, true)
	if err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req protocol.UpdateReportRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	vote := strings.ToLower(strings.TrimSpace(req.Vote))
	resolution := strings.ToLower(strings.TrimSpace(req.Resolution))

	if vote == "" && resolution == "" {
		http.Error(w, `{"error":"vote or resolution required"}`, http.StatusBadRequest)
		return
	}

	if vote != "" {
		if _, ok := allowedReportActions[vote]; !ok {
			http.Error(w, `{"error":"invalid vote"}`, http.StatusBadRequest)
			return
		}
	} else if resolution != "" {
		validResolutions := map[string]struct{}{
			"upheld":              {},
			"dismissed":           {},
			"dismissed_malicious": {},
		}
		if _, ok := validResolutions[resolution]; !ok {
			http.Error(w, `{"error":"invalid resolution"}`, http.StatusBadRequest)
			return
		}
	}

	rec, err := reports.Update(r.Context(), pool, orgID, reportID, actorPubkey, actorRole, req)
	if err != nil {
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			http.Error(w, `{"error":"report not found"}`, http.StatusNotFound)
		case strings.Contains(err.Error(), "forbidden"):
			http.Error(w, errorJSON(err.Error()), http.StatusForbidden)
		case strings.Contains(err.Error(), "already resolved"):
			http.Error(w, errorJSON(err.Error()), http.StatusConflict)
		case strings.Contains(err.Error(), "invalid"):
			http.Error(w, errorJSON(err.Error()), http.StatusBadRequest)
		default:
			http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		}
		return
	}

	writeJSON(w, http.StatusOK, rec)
}

func VoteOnReport(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	reportID := chi.URLParam(r, "reportID")
	if orgID == "" || reportID == "" {
		http.Error(w, `{"error":"org_id and report_id required"}`, http.StatusBadRequest)
		return
	}

	voterPubkey, _, err := authorizeReportActor(r, orgID, true)
	if err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req protocol.VoteOnReportRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	vote := strings.ToLower(strings.TrimSpace(req.Vote))
	if _, ok := allowedReportActions[vote]; !ok {
		http.Error(w, `{"error":"invalid vote: must be uphold, dismiss, or dismiss_malicious"}`, http.StatusBadRequest)
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	var currentStatus string
	err = tx.QueryRow(r.Context(), `
		SELECT status
		FROM reports WHERE org_id = $1 AND id = $2
		FOR UPDATE
	`, orgID, reportID).Scan(&currentStatus)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, `{"error":"report not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	if currentStatus != "pending" {
		http.Error(w, `{"error":"report already resolved"}`, http.StatusConflict)
		return
	}

	_, err = tx.Exec(r.Context(), `
		INSERT INTO report_votes (org_id, report_id, voter_pubkey, vote)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id, report_id, voter_pubkey) DO UPDATE SET vote = $4, created_at = NOW()
	`, orgID, reportID, voterPubkey, vote)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	var upholdCount, dismissCount, dismissMalCount int
	err = tx.QueryRow(r.Context(), `
		SELECT
			COUNT(*) FILTER (WHERE vote = 'uphold'),
			COUNT(*) FILTER (WHERE vote = 'dismiss'),
			COUNT(*) FILTER (WHERE vote = 'dismiss_malicious')
		FROM report_votes WHERE org_id = $1 AND report_id = $2
	`, orgID, reportID).Scan(&upholdCount, &dismissCount, &dismissMalCount)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	response := map[string]any{
		"vote_count_uphold":            upholdCount,
		"vote_count_dismiss":           dismissCount,
		"vote_count_dismiss_malicious": dismissMalCount,
		"status":                       currentStatus,
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, response)
}

type reportRecordForResolution struct {
	ID             string
	MemoryCID      string
	ReporterPubkey string
	ReporterWallet *string
	Reason         string
	Note           *string
}

func resolveReportUpheld(ctx context.Context, tx pgx.Tx, orgID string, reportID string, report *reportRecordForResolution, epoch int) error {
	_, err := tx.Exec(ctx, `
		UPDATE reports SET status = 'upheld_pending_tx', resolved_at = NOW(), updated_at = NOW()
		WHERE org_id = $1 AND id = $2
	`, orgID, reportID)
	return err
}

func resolveReportDismissed(ctx context.Context, tx pgx.Tx, orgID string, reportID string, report *reportRecordForResolution, resolution string) error {
	_, err := tx.Exec(ctx, `
		UPDATE reports SET status = $1, resolution = $1, resolved_at = NOW(), updated_at = NOW()
		WHERE org_id = $2 AND id = $3
	`, resolution, orgID, reportID)
	if err != nil {
		return fmt.Errorf("update report status: %w", err)
	}

	_, err = tx.Exec(ctx, `
		UPDATE members SET dismissed_reports_count = dismissed_reports_count + 1
		WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, report.ReporterPubkey)
	if err != nil {
		return fmt.Errorf("increment dismissed count: %w", err)
	}

	return nil
}

func authorizeReportActor(r *http.Request, orgID string, moderatorOnly bool) (string, string, error) {
	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		return "", "", err
	}

	if err := verifyTimestampSignature(*signed); err != nil {
		return "", "", err
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil {
		return "", "", fmt.Errorf("forbidden: %v", err)
	}

	if moderatorOnly {
		_, canModerate, err := members.GetMemberCapabilities(r.Context(), pool, orgID, signed.Pubkey)
		if err != nil {
			return "", "", fmt.Errorf("forbidden: %v", err)
		}

		if role != "leader" && !canModerate {
			return "", "", fmt.Errorf("forbidden: moderators only")
		}
	}

	return signed.Pubkey, role, nil
}

func verifyTimestampSignature(signed auth.SignedTimestampAuth) error {
	ts, err := time.Parse(time.RFC3339, signed.Timestamp)
	if err != nil {
		return fmt.Errorf(`{"error":"invalid timestamp"}`)
	}

	now := time.Now()
	if now.Sub(ts) > reportTimestampTolerance || ts.Sub(now) > reportTimestampTolerance {
		return fmt.Errorf(`{"error":"timestamp expired or too far in future"}`)
	}

	if err := verify.RequestSignature(signed.Pubkey, signed.Signature, []byte(signed.Timestamp)); err != nil {
		return fmt.Errorf(`{"error":"unauthorized"}`)
	}

	return nil
}

func statusFromAuthError(err error) int {
	switch {
	case errors.Is(err, auth.ErrMissingHeader), errors.Is(err, auth.ErrInvalidScheme), errors.Is(err, auth.ErrMalformedAuth):
		return http.StatusUnauthorized
	default:
		msg := err.Error()
		switch {
		case strings.Contains(msg, "unauthorized"):
			return http.StatusUnauthorized
		case strings.Contains(msg, "forbidden"):
			return http.StatusForbidden
		default:
			return http.StatusBadRequest
		}
	}
}

func errorJSON(msg string) string {
	return `{"error":"` + strings.ReplaceAll(msg, "\"", "'") + `"}`
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(payload)
}

func isMemberOnTrial(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (bool, error) {
	var tier string
	err := pool.QueryRow(ctx, `
		SELECT COALESCE(member_tier, 'member') FROM members WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, pubkey).Scan(&tier)
	if err != nil {
		return false, err
	}
	return tier == "trial", nil
}

func getMemberWallet(ctx context.Context, pool *pgxpool.Pool, orgID, pubkey string) (string, error) {
	var wallet *string
	err := pool.QueryRow(ctx, `
		SELECT wallet_address FROM members WHERE org_id = $1 AND pubkey = $2 AND active = true
	`, orgID, pubkey).Scan(&wallet)
	if err != nil {
		return "", err
	}
	if wallet != nil {
		return *wallet, nil
	}
	return "", nil
}

const maxCommitReasonLength = 500

func CommitReport(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	start := time.Now()
	status := "err"
	var count int
	defer func() {
		wlog.Op(ctx, "hub.commit_report", slog.LevelInfo,
			slog.String("phase", "outcome"),
			slog.String("status", status),
			slog.Int("count", count),
			slog.Int64("dur_ms", time.Since(start).Milliseconds()))
	}()

	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	reportID := chi.URLParam(r, "reportID")
	if orgID == "" || reportID == "" {
		http.Error(w, `{"error":"org_id and report_id required"}`, http.StatusBadRequest)
		return
	}
	wlog.Op(ctx, "hub.commit_report", slog.LevelInfo,
		slog.String("phase", "entry"),
		slog.String("org", orgID),
		slog.String("report", reportID))

	signed, err := auth.ParseWeVibeSigned(r)
	if err != nil {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	if err := verifyTimestampSignature(*signed); err != nil {
		http.Error(w, err.Error(), statusFromAuthError(err))
		return
	}

	role, err := members.GetMemberRole(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || role != "leader" {
		http.Error(w, `{"error":"forbidden: leader only"}`, http.StatusForbidden)
		return
	}

	leaderWallet, err := getMemberWallet(r.Context(), pool, orgID, signed.Pubkey)
	if err != nil || leaderWallet == "" {
		http.Error(w, `{"error":"no wallet address on file for leader"}`, http.StatusForbidden)
		return
	}

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var req struct {
		TxHash          string `json:"tx_hash"`
		Reason          string `json:"reason"`
		WalletPubkey    []byte `json:"wallet_pubkey"`
		WalletSignature []byte `json:"wallet_signature"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.TxHash == "" {
		http.Error(w, `{"error":"tx_hash required"}`, http.StatusBadRequest)
		return
	}

	if len(req.Reason) > maxCommitReasonLength {
		http.Error(w, fmt.Sprintf(`{"error":"reason must be %d characters or fewer"}`, maxCommitReasonLength), http.StatusBadRequest)
		return
	}

	canonicalMsg := verify.BuildCommitCanonicalMessage(orgID, reportID, req.TxHash)
	if err := verify.VerifyCosmosArbitrarySignature(leaderWallet, []byte(canonicalMsg), req.WalletPubkey, req.WalletSignature); err != nil {
		http.Error(w, `{"error":"wallet signature verification failed"}`, http.StatusUnauthorized)
		return
	}

	var currentStatus string
	var memoryCID string
	var reporterPubkey string
	var reporterWallet *string
	var reason string
	var note *string
	err = pool.QueryRow(r.Context(), `
		SELECT status, memory_cid, reporter_pubkey, reporter_wallet, reason, note
		FROM reports WHERE org_id = $1 AND id = $2
	`, orgID, reportID).Scan(&currentStatus, &memoryCID, &reporterPubkey, &reporterWallet, &reason, &note)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			http.Error(w, `{"error":"report not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	if currentStatus != "upheld_pending_tx" {
		http.Error(w, `{"error":"report must be in upheld_pending_tx status to commit"}`, http.StatusBadRequest)
		return
	}

	tx, err := pool.Begin(r.Context())
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}
	defer tx.Rollback(r.Context())

	_, err = tx.Exec(r.Context(), `
		UPDATE reports SET status = 'upheld', resolution = 'upheld', tx_hash = $1, reason = COALESCE($2, reason), resolved_at = NOW(), updated_at = NOW()
		WHERE org_id = $3 AND id = $4
	`, req.TxHash, req.Reason, orgID, reportID)
	if err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}

	if qdrantClient != nil {
		if delErr := qdrantClient.DeletePointByCID(r.Context(), orgID, memoryCID); delErr != nil {
			log.Printf("WARNING: failed to delete memory %s from qdrant: %v", memoryCID, delErr)
		}
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE pending_submissions SET banned = true, status = 'denied', denial_reason = 'memory_upheld_report'
		WHERE org_id = $1 AND submission_hash = $2
	`, orgID, memoryCID); err != nil {
		log.Printf("WARNING: failed to ban pending submission: %v", err)
	}

	if err := tx.Commit(r.Context()); err != nil {
		http.Error(w, errorJSON("internal error"), http.StatusInternalServerError)
		return
	}
	status = "ok"
	count = 1

	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "upheld",
		"tx_hash": req.TxHash,
	})
}
