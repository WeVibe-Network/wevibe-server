package moderation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

func isValidHex64(value string) bool {
	if len(value) != 64 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func SubmitToQueue(ctx context.Context, pool *pgxpool.Pool, req protocol.SubmitMemoryRequest, sanitizationFindings []byte) error {
	if !protocol.IsValidMemoryType(req.MemoryType) {
		return fmt.Errorf("invalid memory_type: %s", req.MemoryType)
	}

	if _, err := hex.DecodeString(req.SubmissionHash); err != nil {
		return fmt.Errorf("invalid submission_hash: %w", err)
	}

	if !isValidHex64(req.PlaintextHash) {
		return fmt.Errorf("invalid plaintext_hash format")
	}

	if !isValidHex64(req.Salt) {
		return fmt.Errorf("invalid salt format")
	}

	canonical := verify.SubmitMemoryMessage(
		req.OrgID,
		req.EpochID,
		req.SubmissionHash,
		req.ContributorPubkey,
		req.MemoryType,
		req.CiphertextHash,
		req.PlaintextHash,
		req.Salt,
		req.WrappedDekHash,
	)
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

	computedCiphertextHash := sha256.Sum256(ciphertextBytes)
	if hex.EncodeToString(computedCiphertextHash[:]) != req.CiphertextHash {
		return fmt.Errorf("ciphertext_hash mismatch")
	}

	computedWrappedDekHash := sha256.Sum256(wrappedDekBytes)
	if hex.EncodeToString(computedWrappedDekHash[:]) != req.WrappedDekHash {
		return fmt.Errorf("wrapped_dek_hash mismatch")
	}

	preferenceConfidence := req.PreferenceConfidence
	if math.IsNaN(preferenceConfidence) || math.IsInf(preferenceConfidence, 0) {
		preferenceConfidence = 0
	}
	if preferenceConfidence < 0 {
		preferenceConfidence = 0
	}
	if preferenceConfidence > 1 {
		preferenceConfidence = 1
	}

	derivation := req.Derivation
	switch derivation {
	case "verbatim", "edited-after-extraction":
	default:
		derivation = "verbatim"
	}

	var extractionResult any
	rawKeywords := req.Keywords
	if keywords := bytes.TrimSpace(rawKeywords); len(keywords) > 0 {
		var parsedKeywords map[string]any
		if err := json.Unmarshal(keywords, &parsedKeywords); err != nil {
			log.Printf("warn: skipping malformed keywords metadata for submission %s: %v", req.SubmissionHash, err)
		} else if len(parsedKeywords) > 0 {
			extractionResult = string(rawKeywords)
		}
	}

	_, err = pool.Exec(ctx, `
		INSERT INTO pending_submissions
			(submission_hash, org_id, epoch_id, contributor_pubkey, ciphertext_hex,
			 plaintext_hash, salt, ciphertext_hash, wrapped_dek_hash,
			 wrapped_dek_mod, contributor_sig, stack_hint, memory_type, preference_confidence, derivation, sanitization_findings, extraction_result, status)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18)
	`,
		req.SubmissionHash, req.OrgID, req.EpochID, req.ContributorPubkey,
		req.Ciphertext, req.PlaintextHash, req.Salt, req.CiphertextHash, req.WrappedDekHash,
		req.WrappedDekMod, req.ContributorSig, req.StackHint, req.MemoryType,
		preferenceConfidence, derivation, sanitizationFindings, extractionResult, protocol.SubmissionStatusPendingKeyword,
	)
	if err != nil {
		return err
	}

	if keywords := bytes.TrimSpace(rawKeywords); len(keywords) > 0 {
		var keywordPayload struct {
			Suggestions []struct {
				Keyword string `json:"keyword"`
			} `json:"suggestions"`
		}
		if err := json.Unmarshal(keywords, &keywordPayload); err != nil {
			log.Printf("warn: skipping keyword candidate capture for submission %s: %v", req.SubmissionHash, err)
			return nil
		}

		for _, suggestion := range keywordPayload.Suggestions {
			keyword := strings.ToLower(strings.TrimSpace(suggestion.Keyword))
			if keyword == "" {
				continue
			}

			if _, err := pool.Exec(ctx, `
				INSERT INTO keyword_candidates (org_id, keyword, contributor_pubkey, submission_hash)
				VALUES ($1, $2, $3, $4)
				ON CONFLICT (org_id, keyword, contributor_pubkey) DO NOTHING
			`, req.OrgID, keyword, req.ContributorPubkey, req.SubmissionHash); err != nil {
				log.Printf("warn: failed recording keyword candidate org=%s keyword=%s contributor=%s submission=%s: %v", req.OrgID, keyword, req.ContributorPubkey, req.SubmissionHash, err)
			}
		}
	}

	return nil
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
	               ps.stack_hint, ps.memory_type, ps.preference_confidence, ps.derivation, ps.created_at, ps.status,
               COALESCE(v.vote_count, 0) AS vote_count,
               COALESCE(v.voter_pubkeys, ARRAY[]::TEXT[]) AS voter_pubkeys
        FROM pending_submissions ps
        LEFT JOIN members m ON m.org_id = ps.org_id AND m.pubkey = ps.contributor_pubkey
        LEFT JOIN (
            SELECT org_id, submission_hash, COUNT(*) AS vote_count,
                   ARRAY_AGG(moderator_pubkey ORDER BY moderator_pubkey) AS voter_pubkeys
	            FROM submission_mod_votes
            GROUP BY org_id, submission_hash
        ) v ON v.org_id = ps.org_id AND v.submission_hash = ps.submission_hash
	        WHERE ps.org_id = $1 AND ps.status = 'pending_keyword'
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
			&item.StackHint, &item.MemoryType, &item.PreferenceConfidence, &item.Derivation, &item.CreatedAt, &item.Status,
			&item.Votes, &item.VoterPubkeys,
		); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type SubmissionVoteTally struct {
	ApproveCount int
	FlagCount    int
	VoterPubkeys []string
}

type KeywordVoteTally struct {
	IncludeCount int
	ExcludeCount int
}

type KeywordVoteEntry struct {
	Keyword string `json:"keyword"`
	Vote    string `json:"vote"`
}

type ModeratorRecommendation struct {
	ModeratorPubkey string             `json:"moderator_pubkey"`
	SubmissionVote  *string            `json:"submission_vote"`
	KeywordVotes    []KeywordVoteEntry `json:"keyword_votes"`
}

func CastApprovalVote(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey, vote string) (approveCount int, flagCount int, err error) {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil {
		return 0, 0, fmt.Errorf("member not found or inactive")
	}
	if role != "moderator" && role != "leader" {
		return 0, 0, fmt.Errorf("insufficient role: %s", role)
	}

	vote = strings.TrimSpace(vote)
	if vote != "approve" && vote != "flag" {
		return 0, 0, fmt.Errorf("invalid vote")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `
        SELECT status FROM pending_submissions
        WHERE org_id = $1 AND submission_hash = $2
        FOR UPDATE
    `, orgID, submissionHash).Scan(&status)
	if err == pgx.ErrNoRows {
		return 0, 0, fmt.Errorf("submission not found")
	}
	if err != nil {
		return 0, 0, err
	}

	switch status {
	case protocol.SubmissionStatusCommitted, protocol.SubmissionStatusDenied:
		return 0, 0, fmt.Errorf("submission already resolved")
	}

	_, err = tx.Exec(ctx, `
        INSERT INTO submission_mod_votes (org_id, submission_hash, moderator_pubkey, vote)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (org_id, submission_hash, moderator_pubkey)
        DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()
    `, orgID, submissionHash, moderatorPubkey, vote)
	if err != nil {
		return 0, 0, err
	}

	var tally SubmissionVoteTally
	err = tx.QueryRow(ctx, `
        SELECT
            COUNT(*) FILTER (WHERE vote = 'approve')::INT AS approve_count,
            COUNT(*) FILTER (WHERE vote = 'flag')::INT AS flag_count,
            COALESCE(ARRAY_AGG(moderator_pubkey ORDER BY moderator_pubkey), ARRAY[]::TEXT[]) AS voter_pubkeys
        FROM submission_mod_votes
        WHERE org_id = $1 AND submission_hash = $2
    `, orgID, submissionHash).Scan(&tally.ApproveCount, &tally.FlagCount, &tally.VoterPubkeys)
	if err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}

	return tally.ApproveCount, tally.FlagCount, nil
}

func ApproveSubmission(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey, memoryType string, vector []float32, embeddingModelID string, embeddingSchemaVersion string) error {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil || (role != "moderator" && role != "leader") {
		return fmt.Errorf("forbidden: not authorized")
	}
	if !protocol.IsValidMemoryType(memoryType) {
		return fmt.Errorf("invalid memory_type: %s", memoryType)
	}
	_, _, err = CastApprovalVote(ctx, pool, orgID, submissionHash, moderatorPubkey, "approve")
	return err
}

func DenySubmission(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, moderatorPubkey, reason string) error {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil || role != "leader" {
		return fmt.Errorf("forbidden")
	}

	result, err := pool.Exec(ctx, `
		UPDATE pending_submissions
		SET status = $1, denial_reason = $2, moderator_pubkey = $3, resolved_at = NOW()
		WHERE submission_hash = $4 AND org_id = $5 AND status IN ($6, $7)
	`, protocol.SubmissionStatusDenied, reason, moderatorPubkey, submissionHash, orgID, protocol.SubmissionStatusPendingKeyword, protocol.SubmissionStatusPendingChain)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return fmt.Errorf("submission not found or already resolved")
	}
	return nil
}

func CastKeywordVote(ctx context.Context, pool *pgxpool.Pool, orgID, submissionHash, keyword, moderatorPubkey, vote string) (includeCount int, excludeCount int, err error) {
	role, err := members.GetMemberRole(ctx, pool, orgID, moderatorPubkey)
	if err != nil {
		return 0, 0, fmt.Errorf("member not found or inactive")
	}
	if role != "moderator" && role != "leader" {
		return 0, 0, fmt.Errorf("insufficient role: %s", role)
	}

	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		return 0, 0, fmt.Errorf("keyword is required")
	}
	vote = strings.TrimSpace(vote)
	if vote != "include" && vote != "exclude" {
		return 0, 0, fmt.Errorf("invalid vote")
	}

	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return 0, 0, err
	}
	defer tx.Rollback(ctx)

	var status string
	err = tx.QueryRow(ctx, `
        SELECT status FROM pending_submissions
        WHERE org_id = $1 AND submission_hash = $2
        FOR UPDATE
    `, orgID, submissionHash).Scan(&status)
	if err == pgx.ErrNoRows {
		return 0, 0, fmt.Errorf("submission not found")
	}
	if err != nil {
		return 0, 0, err
	}

	switch status {
	case protocol.SubmissionStatusCommitted, protocol.SubmissionStatusDenied:
		return 0, 0, fmt.Errorf("submission already resolved")
	}

	_, err = tx.Exec(ctx, `
        INSERT INTO keyword_mod_votes (org_id, submission_hash, keyword, moderator_pubkey, vote)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (org_id, submission_hash, keyword, moderator_pubkey)
        DO UPDATE SET vote = EXCLUDED.vote, created_at = NOW()
    `, orgID, submissionHash, keyword, moderatorPubkey, vote)
	if err != nil {
		return 0, 0, err
	}

	err = tx.QueryRow(ctx, `
        SELECT
            COUNT(*) FILTER (WHERE vote = 'include')::INT AS include_count,
            COUNT(*) FILTER (WHERE vote = 'exclude')::INT AS exclude_count
        FROM keyword_mod_votes
        WHERE org_id = $1 AND submission_hash = $2 AND keyword = $3
    `, orgID, submissionHash, keyword).Scan(&includeCount, &excludeCount)
	if err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(ctx); err != nil {
		return 0, 0, err
	}

	return includeCount, excludeCount, nil
}

func GetSubmissionVoteTallies(ctx context.Context, pool *pgxpool.Pool, orgID string, submissionHashes []string) (map[string]SubmissionVoteTally, error) {
	tallies := make(map[string]SubmissionVoteTally)
	if len(submissionHashes) == 0 {
		return tallies, nil
	}

	rows, err := pool.Query(ctx, `
        SELECT
            submission_hash,
            COUNT(*) FILTER (WHERE vote = 'approve')::INT AS approve_count,
            COUNT(*) FILTER (WHERE vote = 'flag')::INT AS flag_count,
            COALESCE(ARRAY_AGG(moderator_pubkey ORDER BY moderator_pubkey), ARRAY[]::TEXT[]) AS voter_pubkeys
        FROM submission_mod_votes
        WHERE org_id = $1 AND submission_hash = ANY($2)
        GROUP BY submission_hash
    `, orgID, submissionHashes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var submissionHash string
		var tally SubmissionVoteTally
		if err := rows.Scan(&submissionHash, &tally.ApproveCount, &tally.FlagCount, &tally.VoterPubkeys); err != nil {
			return nil, err
		}
		tallies[submissionHash] = tally
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return tallies, nil
}

func GetKeywordVoteTallies(ctx context.Context, pool *pgxpool.Pool, orgID string, submissionHashes []string) (map[string]map[string]KeywordVoteTally, error) {
	tallies := make(map[string]map[string]KeywordVoteTally)
	if len(submissionHashes) == 0 {
		return tallies, nil
	}

	rows, err := pool.Query(ctx, `
        SELECT
            submission_hash,
            keyword,
            COUNT(*) FILTER (WHERE vote = 'include')::INT AS include_count,
            COUNT(*) FILTER (WHERE vote = 'exclude')::INT AS exclude_count
        FROM keyword_mod_votes
        WHERE org_id = $1 AND submission_hash = ANY($2)
        GROUP BY submission_hash, keyword
    `, orgID, submissionHashes)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var submissionHash string
		var keyword string
		var tally KeywordVoteTally
		if err := rows.Scan(&submissionHash, &keyword, &tally.IncludeCount, &tally.ExcludeCount); err != nil {
			return nil, err
		}
		if _, exists := tallies[submissionHash]; !exists {
			tallies[submissionHash] = make(map[string]KeywordVoteTally)
		}
		tallies[submissionHash][keyword] = tally
	}

	if err := rows.Err(); err != nil {
		return nil, err
	}

	return tallies, nil
}

func GetModeratorRecommendations(ctx context.Context, pool *pgxpool.Pool, orgID string, submissionHashes []string) (map[string][]ModeratorRecommendation, error) {
	recommendations := make(map[string][]ModeratorRecommendation)
	if len(submissionHashes) == 0 {
		return recommendations, nil
	}

	bySubmission := make(map[string]map[string]*ModeratorRecommendation)
	getOrCreateRecommendation := func(submissionHash, moderatorPubkey string) *ModeratorRecommendation {
		moderatorMap, ok := bySubmission[submissionHash]
		if !ok {
			moderatorMap = make(map[string]*ModeratorRecommendation)
			bySubmission[submissionHash] = moderatorMap
		}

		recommendation, ok := moderatorMap[moderatorPubkey]
		if !ok {
			recommendation = &ModeratorRecommendation{
				ModeratorPubkey: moderatorPubkey,
				KeywordVotes:    []KeywordVoteEntry{},
			}
			moderatorMap[moderatorPubkey] = recommendation
		}

		return recommendation
	}

	submissionVoteRows, err := pool.Query(ctx, `
        SELECT submission_hash, moderator_pubkey, vote
        FROM submission_mod_votes
        WHERE org_id = $1 AND submission_hash = ANY($2)
    `, orgID, submissionHashes)
	if err != nil {
		return nil, err
	}
	defer submissionVoteRows.Close()

	for submissionVoteRows.Next() {
		var submissionHash string
		var moderatorPubkey string
		var vote string
		if err := submissionVoteRows.Scan(&submissionHash, &moderatorPubkey, &vote); err != nil {
			return nil, err
		}

		recommendation := getOrCreateRecommendation(submissionHash, moderatorPubkey)
		voteCopy := vote
		recommendation.SubmissionVote = &voteCopy
	}

	if err := submissionVoteRows.Err(); err != nil {
		return nil, err
	}

	keywordVoteRows, err := pool.Query(ctx, `
        SELECT submission_hash, moderator_pubkey, keyword, vote
        FROM keyword_mod_votes
        WHERE org_id = $1 AND submission_hash = ANY($2)
    `, orgID, submissionHashes)
	if err != nil {
		return nil, err
	}
	defer keywordVoteRows.Close()

	for keywordVoteRows.Next() {
		var submissionHash string
		var moderatorPubkey string
		var keyword string
		var vote string
		if err := keywordVoteRows.Scan(&submissionHash, &moderatorPubkey, &keyword, &vote); err != nil {
			return nil, err
		}

		recommendation := getOrCreateRecommendation(submissionHash, moderatorPubkey)
		recommendation.KeywordVotes = append(recommendation.KeywordVotes, KeywordVoteEntry{
			Keyword: keyword,
			Vote:    vote,
		})
	}

	if err := keywordVoteRows.Err(); err != nil {
		return nil, err
	}

	for submissionHash, moderatorMap := range bySubmission {
		moderatorPubkeys := make([]string, 0, len(moderatorMap))
		for moderatorPubkey := range moderatorMap {
			moderatorPubkeys = append(moderatorPubkeys, moderatorPubkey)
		}
		sort.Strings(moderatorPubkeys)

		submissionRecommendations := make([]ModeratorRecommendation, 0, len(moderatorPubkeys))
		for _, moderatorPubkey := range moderatorPubkeys {
			recommendation := moderatorMap[moderatorPubkey]
			sort.Slice(recommendation.KeywordVotes, func(i, j int) bool {
				if recommendation.KeywordVotes[i].Keyword == recommendation.KeywordVotes[j].Keyword {
					return recommendation.KeywordVotes[i].Vote < recommendation.KeywordVotes[j].Vote
				}
				return recommendation.KeywordVotes[i].Keyword < recommendation.KeywordVotes[j].Keyword
			})

			var submissionVote *string
			if recommendation.SubmissionVote != nil {
				voteCopy := *recommendation.SubmissionVote
				submissionVote = &voteCopy
			}

			submissionRecommendations = append(submissionRecommendations, ModeratorRecommendation{
				ModeratorPubkey: recommendation.ModeratorPubkey,
				SubmissionVote:  submissionVote,
				KeywordVotes:    recommendation.KeywordVotes,
			})
		}

		recommendations[submissionHash] = submissionRecommendations
	}

	return recommendations, nil
}
