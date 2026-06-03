package handlers

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/protocol"
)

type DiscoverResponse struct {
	Orgs    []protocol.DiscoverOrg `json:"orgs"`
	Total   int                    `json:"total"`
	HasMore bool                   `json:"has_more"`
}

func DiscoverOrgs(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	limitStr := r.URL.Query().Get("limit")
	offsetStr := r.URL.Query().Get("offset")
	search := r.URL.Query().Get("search")

	limit := 20
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
			limit = l
		}
	}

	offset := 0
	if offsetStr != "" {
		if o, err := strconv.Atoi(offsetStr); err == nil && o >= 0 {
			offset = o
		}
	}

	ctx := r.Context()

	query := `
		SELECT o.org_id, o.org_name, o.domain, o.leader_pubkey, o.current_epoch, o.created_at,
			   COUNT(m.pubkey) FILTER (WHERE m.active = true) as member_count,
			   o.last_chain_submission_at
		FROM orgs o
		LEFT JOIN members m ON m.org_id = o.org_id
		WHERE o.status = 'active'
	`
	countQuery := `SELECT COUNT(*) FROM orgs o WHERE o.status = 'active'`

	args := []interface{}{}
	argIdx := 1

	if search != "" {
		query += ` AND o.org_name ILIKE '%' || $` + strconv.Itoa(argIdx) + ` || '%'`
		countQuery += ` AND o.org_name ILIKE '%' || $` + strconv.Itoa(argIdx) + ` || '%'`
		args = append(args, search)
		argIdx++
	}

	query += ` GROUP BY o.org_id, o.last_chain_submission_at ORDER BY o.last_chain_submission_at DESC NULLS LAST, o.created_at DESC LIMIT $` + strconv.Itoa(argIdx) + ` OFFSET $` + strconv.Itoa(argIdx+1)
	args = append(args, limit, offset)

	rows, err := pool.Query(ctx, query, args...)
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var orgs []protocol.DiscoverOrg
	for rows.Next() {
		var org protocol.DiscoverOrg
		var createdAt time.Time
		var lastActivity *time.Time
		if err := rows.Scan(&org.OrgID, &org.OrgName, &org.Domain, &org.LeaderPubkey, &org.CurrentEpoch, &createdAt, &org.MemberCount, &lastActivity); err != nil {
			log.Printf("WARNING: discovery row scan failed, skipping row: %v", err)
			continue
		}
		org.CreatedAt = createdAt.Format(time.RFC3339)
		if lastActivity != nil {
			la := lastActivity.Format(time.RFC3339)
			org.LastActivityAt = &la
		}
		orgs = append(orgs, org)
	}

	var total int
	countArgs := []interface{}{}
	if search != "" {
		countArgs = append(countArgs, search)
	}
	if err := pool.QueryRow(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		total = 0
	}

	resp := DiscoverResponse{
		Orgs:    orgs,
		Total:   total,
		HasMore: offset+len(orgs) < total,
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}
