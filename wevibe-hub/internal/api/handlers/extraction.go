package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
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
	extractionProfileDefaultModel         = "qwen3:4b"
	extractionProfileRecommendedPresetID  = "balanced-reliable"
	extractionProfileSystemPromptMaxBytes = 16384
	extractionProfileNumCtxMax            = 131072
)

type extractionProfileResponse struct {
	Found        bool   `json:"found"`
	SystemPrompt string `json:"system_prompt"`
	NumCtx       int    `json:"num_ctx"`
	Model        string `json:"model"`
	PresetID     string `json:"preset_id"`
	UpdatedAt    string `json:"updated_at"`
}

type setExtractionProfileRequest struct {
	SystemPrompt string `json:"system_prompt"`
	NumCtx       int    `json:"num_ctx"`
	Model        string `json:"model"`
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
	DefaultModel  string             `json:"default_model"`
}

const extractionPresetContract = `Output ONLY a JSON array. Each element has EXACTLY these keys and no others:
- "implement": string (REQUIRED) — what TO do and how, phrased as "<do this> because <reason or consequence>; applies when <condition>". Specific and actionable.
- "context": string — environment, versions, conditions where this applies. Reusable applicability only; never "during this session" or "for this task".
- "dnd": string or null — what NOT to do and the EXACT consequence (negative knowledge); null if there is no negative signal.
- "stack": array of lowercase strings — the specific technologies involved.
- "memory_type": string — always exactly "memory".
- "preference_confidence": number — EXACTLY one of 0.0, 0.2, 0.5, 0.8.
Do NOT output any other key. Do NOT output "extraction_hash" (the engine computes it). Do NOT output keywords.
Do NOT wrap the array in markdown code fences and do NOT add any prose before or after it.
Output the bare JSON array only. If nothing durable was learned, output exactly: []`

const extractionPresetGates = `HOW TO SELECT MEMORIES. Apply these gates to every candidate. Do the classification SILENTLY and FIRST; compose prose only for the survivors. Never output your reasoning, scores, or tags.

1. PROVENANCE (do this before composing anything). For each candidate insight, locate where it came from in the transcript and tag it:
   - ASSIGNED — it appears in the setup / work order / user instruction: something the worker was TOLD to do, stated with no in-session reason (e.g. "delete these IDs", "rename X to Y", "write the report to path P", "do not run git here").
   - LEARNED — it EMERGED during execution: a command failed, a constraint was hit, a correction happened, a discovery was made, OR an existing convention/invariant was uncovered that explains WHY an instruction exists.
   KEEP a candidate only if (a) it is LEARNED, or (b) an ASSIGNED instruction can be restated as the durable RULE it instantiates AND the transcript supplies the reason. If you cannot point to an in-session cause, DROP it.

2. RECALL VALUE (rate internally, never output). 0 = one-shot task parameter; 1 = recurs only if this exact artifact/list/path recurs; 2 = reusable for this repo/subsystem/tool/workflow; 3 = prevents data loss, security, corruption, or repeat-debugging, or captures a core invariant. Keep only recall value >= 2.

3. BECAUSE-TEST. Every "implement" must encode mechanism + justification: "<do this> because <causal reason or consequence>; applies when <condition>". If you cannot state a non-circular "because" grounded in the transcript, the candidate is an instruction, not a learning — DROP it.

4. SCOPED SPECIFICITY. Specificity must attach to the REUSABLE MECHANISM, never the one-off payload.
   KEEP: exact flags, versions, config keys, error strings, causal thresholds, directive names, commands.
   STRIP: session-instance identifiers — specific IDs to delete/keep, target file paths, report destinations, ticket/PR names, raw line numbers.
   TEST: mentally remove every instance-identifier; if nothing of reusable substance remains, the candidate was pure instruction — DROP it. Also DROP generic advice with no mechanism ("write tests", "use caching", "handle errors").

5. ABSTRACTION + GROUNDING. Generalize AT MOST one level above the transcript and preserve scope (this repo / this document / this tool / this workflow / this version). ALLOWED: "MASTER.md keeps open gaps only; resolved gaps move to implementation reports." NOT ALLOWED: "All teams should manage gap logs this way." A LEARNED generalization must be supported by a transcript span you could point to (a stated rule, an observed failure+fix, the final accepted implementation, or file/config/test content). Do NOT invent a "convention" from a single instruction that carries no stated reason.

6. WHEN AN INSTRUCTION IS DURABLE. A manager/work-order instruction is KEPT (restated as a rule) only if BOTH: (a) it carries a standing-rule signal — "always", "never", "policy", "convention", "invariant", "in this repo", "workers must", or it explains a reusable reason/consequence; AND (b) you can ground it (confirmed by an edit, a doc/config, or a stated reason). Otherwise it is one-shot task scope — DROP it.

7. dnd (negative knowledge) — only when DURABLE.
   - Mine failures actively: errors, regressions, silent failures, ordering hazards, resource thresholds, version-mismatch footguns, security anti-patterns. "It broke when…" moments are the highest-value targets.
   - A dnd must be SELF-CONTAINED: name the EXACT trigger AND EXACT consequence (not "avoid bad config" but "do not set worker_threads above 4 on a t2.micro or the OOM killer terminates node").
   - Pack the error string / symptom a future coder would search by into the dnd or implement text (there is no separate symptom field).
   - Pair every guardrail with the correct alternative in "implement" — UNLESS the transcript never demonstrated the fix; never fabricate an alternative.
   - dnd = null when there is no negative signal; do not force balance.
   - Provenance applies: "do not run git for THIS task" is ASSIGNED scope — DROP it; keep the durable footgun ("destructive git on a shared tree destroys uncommitted work irrecoverably").
   - NEVER broaden a scoped prohibition into a false universal; narrow it to its real reusable scope and consequence.
   - One hazard = one memory: keep the failure + its symptom + its fix together; do not split them across memories.

8. PREFERENCE (preference_confidence). Emit EXACTLY one of:
   0.0 FACT — reproducible/measurable behavior, error code, API fact, OR an observed in-session failure.
   0.2 CONVENTION — "THIS org/project/repo does X" (valid, low subjectivity).
   0.5 MIXED — blends fact and opinion.
   0.8 TASTE — a stylistic claim with weak or no technical justification.
   Score SUBSTANCE not tone: a strongly-worded fact is 0.0; a hedged opinion is high. NEVER emit pure taste (would-be 1.0) — DROP it. Suppress at emission: drop a 0.8 candidate that has no verifiable technical core; KEEP and flag a high-preference candidate that DOES carry a concrete core (the org-convention-as-fact case).

9. SECRETS / PII. Never extract API keys, tokens, passwords, private keys, session cookies, credentials, or personal emails/phones, and never lift secrets out of logs. Prefer repo-relative paths over user-specific absolute paths.

EXPECTED YIELD (calibration only — NOT a target; never pad to fill and never drop to hit a number):
   mechanical task / cleanup / checklist: usually 0–3 (often []);
   debugging / incident: usually 1–6;
   design / convention-setting: usually 1–5;
   implementation with discoveries: usually 1–6;
   mixed: apply the gates PER CANDIDATE.
   Returning [] is correct when nothing durable was learned. HARD MAX 10 (a backstop, not a quota): if more survive, emit the highest-ranked by data-loss/security/corruption prevention > failure+fix > stable convention > reusable technique > lower-risk process rule.`

const extractionPresetExemplar = `EXAMPLE. Transcript: the user says "Delete GAP-1..GAP-32 from MASTER.md, keep GAP-SEC-1, write the report to /tmp/cleanup.txt, do not run git." The worker opens MASTER.md, notes it holds only OPEN gaps, deletes the resolved ones, and writes the report.

CORRECT OUTPUT:
[{"implement":"Maintain MASTER.md as an open-gaps-only log because resolved-gap history is preserved in implementation reports; when closing a gap, remove its heading, status line, body, and separator entirely. Applies when editing the gap log.","context":"MASTER.md-style gap-log documentation workflow","dnd":null,"stack":["markdown","documentation"],"memory_type":"memory","preference_confidence":0.2},{"implement":"Anchor edits to large, frequently-changing Markdown docs on stable section headings or IDs because raw line numbers drift across insertions and deletions and will target the wrong content. Applies when editing big evolving docs.","context":"Large Markdown docs with stable headings/IDs","dnd":"Do not use raw line numbers as edit anchors in changing docs; they drift and corrupt unrelated content.","stack":["markdown","documentation"],"memory_type":"memory","preference_confidence":0.0},{"implement":"In delegated or shared-worktree sessions, inspect state with read-only git and require authorization before any destructive operation, because uncommitted work is otherwise lost. Applies to collaborative Git work.","context":"Collaborative Git sessions on a shared working tree with possible uncommitted changes","dnd":"Do not run git checkout/restore/reset/clean/stash on a shared tree without authorization; uncommitted work is silently and irrecoverably destroyed.","stack":["git"],"memory_type":"memory","preference_confidence":0.0}]

DROPPED (and why): the 32 delete-IDs and the 15 keep-IDs (ASSIGNED one-off scope, no reusable rule); the /tmp/cleanup.txt path (one-off deliverable); "do not commit for this task" (ASSIGNED scope, not a durable footgun).`

const extractionPresetStrategyFactualStrict = `You are a strict technical-memory extractor. Apply the selection gates below to every candidate. Among the survivors, rank and emphasize verifiable facts and high-specificity mechanisms (exact values, keys, flags, versions, error strings, commands). Do NOT emit every exact fact — emit only those that pass the provenance, because, recall-value, and specificity gates.`

const extractionPresetStrategyGuardrailMax = `You are a negative-knowledge-focused technical-memory extractor. Apply the selection gates below to every candidate. Among the survivors, rank and emphasize durable, high-consequence footguns (data loss, security, corruption, silent failure), each paired with its correct fix in "implement". Do NOT harvest every "do not" — emit only durable hazards that pass the gates.`

const extractionPresetStrategyBalancedReliable = `You are a reliable, consistent technical-memory extractor. Apply the selection gates below to every candidate. Among the survivors, balance positive guidance ("implement") and negative knowledge ("dnd"), ranking by durability and consequence. Use consistent terminology across runs so memories compose cleanly across the org's corpus.`

// NOTE: Static duplicate of wevibe-mcp/src/extraction-presets.ts; IDs/labels/goals/recommended flags/system prompts must stay byte-identical and in sync.
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
		SELECT system_prompt, num_ctx, model, preset_id, updated_at
		FROM org_extraction_profile
		WHERE org_id = $1
	`, orgID).Scan(&resp.SystemPrompt, &resp.NumCtx, &resp.Model, &resp.PresetID, &updatedAt)
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
		INSERT INTO org_extraction_profile (org_id, system_prompt, num_ctx, model, preset_id)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (org_id) DO UPDATE
		SET system_prompt = EXCLUDED.system_prompt,
		    num_ctx = EXCLUDED.num_ctx,
		    model = EXCLUDED.model,
		    preset_id = EXCLUDED.preset_id,
		    updated_at = NOW()
		RETURNING system_prompt, num_ctx, model, preset_id, updated_at
	`, orgID, req.SystemPrompt, req.NumCtx, req.Model, req.PresetID).Scan(&resp.SystemPrompt, &resp.NumCtx, &resp.Model, &resp.PresetID, &updatedAt)
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
		DefaultModel:  extractionProfileDefaultModel,
	})
}
