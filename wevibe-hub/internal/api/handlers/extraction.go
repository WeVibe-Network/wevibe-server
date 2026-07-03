package handlers

import (
	"embed"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/auth"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/members"
	"github.com/wevibe-network/wevibe-server/wevibe-hub/internal/verify"
)

const (
	extractionProfileDefaultNumCtx        = 32768
	extractionProfileRecommendedPresetID  = "balanced-reliable"
	extractionProfileSystemPromptMaxBytes = 16384
	extractionProfileNumCtxMax            = 131072
)

type extractionProfileResponse struct {
	Found        bool   `json:"found"`
	SystemPrompt string `json:"system_prompt"`
	NumCtx       int    `json:"num_ctx"`
	PresetID     string `json:"preset_id"`
	UpdatedAt    string `json:"updated_at"`
}

type setExtractionProfileRequest struct {
	SystemPrompt string `json:"system_prompt"`
	NumCtx       int    `json:"num_ctx"`
	PresetID     string `json:"preset_id"`
}

type extractionPreset struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Goal         string `json:"goal"`
	Recommended  bool   `json:"recommended"`
	SystemPrompt string `json:"system_prompt"`
}

type extractionPresetsResponse struct {
	Presets       []extractionPreset `json:"presets"`
	RecommendedID string             `json:"recommended_id"`
	DefaultNumCtx int                `json:"default_num_ctx"`
}

// Fragments are embedded from vendored copies synced via make sync-extraction-prompts.
//
//go:embed prompts/memory-extraction/*.md
var extractionPromptFS embed.FS

func readExtractionPrompt(name string) string {
	b, err := extractionPromptFS.ReadFile("prompts/memory-extraction/" + name)
	if err != nil {
		panic("extraction prompt missing: " + name + ": " + err.Error())
	}
	return strings.TrimSuffix(string(b), "\n")
}

var (
	extractionPresetContract                 = readExtractionPrompt("contract.md")
	extractionPresetGates                    = readExtractionPrompt("gates.md")
	extractionPresetExemplar                 = readExtractionPrompt("exemplar.md")
	extractionPresetStrategyFactualStrict    = readExtractionPrompt("strategy-factual-strict.md")
	extractionPresetStrategyGuardrailMax     = readExtractionPrompt("strategy-guardrail-max.md")
	extractionPresetStrategyBalancedReliable = readExtractionPrompt("strategy-balanced-reliable.md")
)

var extractionPresets = []extractionPreset{
	{
		ID:           "factual-strict",
		Label:        "Factual-Strict",
		Goal:         "Minimize preference, maximize specificity (fewer, sharper memories).",
		Recommended:  false,
		SystemPrompt: extractionPresetStrategyFactualStrict + "\n\n" + extractionPresetGates + "\n\n" + extractionPresetExemplar + "\n\n" + extractionPresetContract,
	},
	{
		ID:           "guardrail-max",
		Label:        "Guardrail-Max",
		Goal:         "Maximize high-quality negative signals (DND footguns + fixes).",
		Recommended:  false,
		SystemPrompt: extractionPresetStrategyGuardrailMax + "\n\n" + extractionPresetGates + "\n\n" + extractionPresetExemplar + "\n\n" + extractionPresetContract,
	},
	{
		ID:           "balanced-reliable",
		Label:        "Balanced-Reliable",
		Goal:         "Balanced, schema-stable, reliable + continuity (recommended).",
		Recommended:  true,
		SystemPrompt: extractionPresetStrategyBalancedReliable + "\n\n" + extractionPresetGates + "\n\n" + extractionPresetExemplar + "\n\n" + extractionPresetContract,
	},
}

func GetExtractionProfile(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
		return
	}

	orgID := chi.URLParam(r, "orgID")
	if orgID == "" {
		http.Error(w, `{"error":"org_id required"}`, http.StatusBadRequest)
		return
	}

	resp := extractionProfileResponse{}
	var updatedAt time.Time
	err := pool.QueryRow(r.Context(), `
		SELECT system_prompt, num_ctx, preset_id, updated_at
		FROM org_extraction_profile
		WHERE org_id = $1
	`, orgID).Scan(&resp.SystemPrompt, &resp.NumCtx, &resp.PresetID, &updatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
		return
	}
	if err != nil {
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	resp.Found = true
	resp.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func SetExtractionProfile(w http.ResponseWriter, r *http.Request) {
	if pool == nil {
		http.Error(w, `{"error":"database unavailable"}`, http.StatusServiceUnavailable)
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

	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, `{"error":"bad request"}`, http.StatusBadRequest)
		return
	}

	var req setExtractionProfileRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, `{"error":"invalid json"}`, http.StatusBadRequest)
		return
	}

	if req.NumCtx < 0 || req.NumCtx > extractionProfileNumCtxMax {
		http.Error(w, `{"error":"num_ctx must be between 0 and 131072"}`, http.StatusBadRequest)
		return
	}
	if len(req.SystemPrompt) > extractionProfileSystemPromptMaxBytes {
		http.Error(w, `{"error":"system_prompt exceeds 16384 bytes"}`, http.StatusBadRequest)
		return
	}

	resp := extractionProfileResponse{}
	var updatedAt time.Time
	err = pool.QueryRow(r.Context(), `
		INSERT INTO org_extraction_profile (org_id, system_prompt, num_ctx, preset_id)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (org_id) DO UPDATE
		SET system_prompt = EXCLUDED.system_prompt,
		    num_ctx = EXCLUDED.num_ctx,
		    preset_id = EXCLUDED.preset_id,
		    updated_at = NOW()
		RETURNING system_prompt, num_ctx, preset_id, updated_at
	`, orgID, req.SystemPrompt, req.NumCtx, req.PresetID).Scan(&resp.SystemPrompt, &resp.NumCtx, &resp.PresetID, &updatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			http.Error(w, `{"error":"org not found"}`, http.StatusNotFound)
			return
		}
		http.Error(w, `{"error":"internal error"}`, http.StatusInternalServerError)
		return
	}

	resp.Found = true
	resp.UpdatedAt = updatedAt.UTC().Format(time.RFC3339)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func GetExtractionPresets(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(extractionPresetsResponse{
		Presets:       extractionPresets,
		RecommendedID: extractionProfileRecommendedPresetID,
		DefaultNumCtx: extractionProfileDefaultNumCtx,
	})
}
