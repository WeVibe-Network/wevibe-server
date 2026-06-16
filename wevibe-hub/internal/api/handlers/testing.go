package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/embed"
)

type TestHealthResponse struct {
	Status           string    `json:"status"`
	Timestamp        time.Time `json:"timestamp"`
	Version          string    `json:"version"`
	DB               string    `json:"db"`
	Chain            string    `json:"chain"`
	ChainID          string    `json:"chain_id,omitempty"`
	SubmitterAddress string    `json:"submitter_address,omitempty"`
	Qdrant           string    `json:"qdrant"`
}

func TestHealth(w http.ResponseWriter, r *http.Request) {
	dbStatus := "disconnected"
	if pool != nil {
		if err := pool.Ping(r.Context()); err == nil {
			dbStatus = "connected"
		}
	}

	chainStatus := "disconnected"
	chainID := ""
	submitterAddr := ""
	if chainClient != nil {
		chainStatus = "connected"
		chainID = chainClient.GetChainID()
		submitterAddr = chainClient.SubmitterAddress()
	}

	qdrantStatus := "disconnected"
	if qdrantClient != nil {
		qdrantStatus = "connected"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(TestHealthResponse{
		Status:           "ok",
		Timestamp:        time.Now().UTC(),
		Version:          "0.2.0",
		DB:               dbStatus,
		Chain:            chainStatus,
		ChainID:          chainID,
		SubmitterAddress: submitterAddr,
		Qdrant:           qdrantStatus,
	})
}

type TestEmbedRequest struct {
	Text string `json:"text"`
}

type TestEmbedResponse struct {
	Vector []float32 `json:"vector"`
	Model  string    `json:"model"`
	Dim    int       `json:"dim"`
}

func TestEmbed(w http.ResponseWriter, r *http.Request) {
	var req TestEmbedRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid JSON"}`, http.StatusBadRequest)
		return
	}
	if req.Text == "" {
		http.Error(w, `{"error":"text required"}`, http.StatusBadRequest)
		return
	}
	vec, modelID, err := embed.GetEmbedding(r.Context(), req.Text)
	if err != nil {
		http.Error(w, `{"error":"`+err.Error()+`"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(TestEmbedResponse{
		Vector: vec,
		Model:  modelID,
		Dim:    len(vec),
	})
}

type TestUpdateRoleRequest struct {
	Pubkey  string `json:"pubkey"`
	NewRole string `json:"new_role"`
}

// TestServeQueueDepth reports how many serve/denial events are still pending
// relay to the chain for an org. The empirical replay polls this between epochs
// to wait for each epoch's traffic to land on-chain before advancing, bounding
// relay lag so per-epoch decay is assessed against settled traffic rather than
// an empty (not-yet-relayed) epoch. Read-only; test-mode only.
func TestServeQueueDepth(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"db unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	var pendingServes, pendingDenials int
	if err := pool.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM serve_events WHERE org_id=$1 AND status='pending' AND event_type='serve'`,
		orgID).Scan(&pendingServes); err != nil {
		http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
		return
	}
	if err := pool.QueryRow(r.Context(),
		`SELECT COUNT(*) FROM serve_events WHERE org_id=$1 AND status='pending' AND event_type='denial'`,
		orgID).Scan(&pendingDenials); err != nil {
		http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]int{
		"pending_serves":  pendingServes,
		"pending_denials": pendingDenials,
		"pending_total":   pendingServes + pendingDenials,
	})
}

func TestGetQueue(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"db unavailable"}`, http.StatusServiceUnavailable)
		return
	}
	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}
	rows, err := pool.Query(r.Context(), `
		SELECT submission_hash, contributor_pubkey, epoch_id, ciphertext_hex,
			   wrapped_dek_mod, stack_hint, status, created_at
		FROM pending_submissions
		WHERE org_id = $1
		ORDER BY created_at DESC
	`, orgID)
	if err != nil {
		http.Error(w, `{"error":"query failed"}`, http.StatusInternalServerError)
		return
	}
	defer rows.Close()
	var items []map[string]any
	for rows.Next() {
		var hash, contributor, ciphertext, wrappedDek, status string
		var epochID int
		var createdAt time.Time
		var stackHintStr string
		if err := rows.Scan(&hash, &contributor, &epochID, &ciphertext, &wrappedDek, &stackHintStr, &status, &createdAt); err != nil {
			continue
		}
		var stackHint []string
		if stackHintStr != "" {
			_ = json.Unmarshal([]byte(stackHintStr), &stackHint)
		}
		items = append(items, map[string]any{
			"submission_hash":    hash,
			"contributor_pubkey": contributor,
			"epoch_id":           epochID,
			"ciphertext_hex":     ciphertext,
			"wrapped_dek_mod":    wrappedDek,
			"stack_hint":         stackHint,
			"status":             status,
			"created_at":         createdAt,
		})
	}
	if items == nil {
		items = []map[string]any{}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(items)
}
